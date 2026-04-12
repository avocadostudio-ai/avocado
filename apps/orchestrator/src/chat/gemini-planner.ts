import { z } from "zod"
import {
  allowedBlockTypes,
  editPlanSchema,
  type BlockManifest,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import { buildIntentParserSystemPrompt, buildPlannerSystemPrompt } from "./prompts.js"
import { isDemoModeEnabled } from "../demo-mode.js"
import {
  type ParsedIntent,
  extractAudienceTarget,
  fetchImageAsBase64,
  intentSchema,
  plannerContextPack
} from "../nlp/deterministic-planner.js"
import { isBatchAddRequest, isBatchRemoveRequest, isBatchReorderRequest, isPageWideRewriteRequest } from "../nlp/intent-detection.js"
import {
  extractJsonObject,
  normalizePlanCandidate,
  repairAndParseJsonWithMeta
} from "../nlp/plan-normalizer.js"
import { type TokenUsage, ZERO_USAGE } from "../telemetry/usage.js"
import { editPlanJsonSchema, intentJsonSchema } from "./plan-json-schema.js"
import { executeToolCall, type ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"
import {
  PlannerError,
  type PlannerFailureReasonCategory
} from "../errors.js"
import {
  extractSummaryFromPlanBuffer,
  extractOpsFromPlanBuffer,
  extractUpdatePropsFieldDraftsFromPlanBuffer,
  isChatStrictPrimaryOpMode,
  isPageWideTranslationRequest,
  buildPlannerSchemaContext,
  type PlannerSchemaContextMeta,
  type PlannerContractMode
} from "./planner.js"
import { getGeminiClient } from "../image/image-helpers.js"
import {
  GENERATING_IMAGE_PLACEHOLDER,
  SEARCHING_IMAGE_PLACEHOLDER,
  type DeferredNativeImageCall,
  DEFERRABLE_IMAGE_TOOLS
} from "./chat-pipeline-shared.js"

const geminiEditPlanSchema = {
  ...editPlanJsonSchema,
  propertyOrdering: ["intent", "summary_for_user", "change_log", "ops", "suggested_next_actions"]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Lenient: change_log can be string or array (Gemini returns string per schema,
// normalizePlanCandidate converts it downstream).
const rawPlanCandidateSchema = z.looseObject({
  intent: z.enum(["edit_plan", "needs_clarification", "content_answer"]).optional().catch(undefined),
  summary_for_user: z.string().optional(),
  change_log: z.union([z.array(z.string()), z.string()]).optional(),
  ops: z.array(z.record(z.string(), z.unknown())).optional(),
  suggested_next_actions: z.union([z.array(z.string()), z.string()]).optional()
})

function toPlannerError(category: PlannerFailureReasonCategory, message: string, retryable = false) {
  return new PlannerError(message, { reasonCategory: category, retryable })
}

function extractGeminiUsage(response: unknown): TokenUsage {
  const meta = (response as { usageMetadata?: Record<string, unknown> })?.usageMetadata
  if (!meta) return { ...ZERO_USAGE }
  const inputTokens = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0
  const outputTokens = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function extractGeminiText(response: unknown): string {
  const candidates = (response as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ""
  const parts = candidates[0]?.content?.parts
  if (!Array.isArray(parts)) return ""
  return parts.map((p) => p.text ?? "").join("")
}

function extractGeminiFunctionCalls(response: unknown): Array<{ name: string; args: Record<string, unknown> }> {
  const candidates = (response as { candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name: string; args: Record<string, unknown> } }> } }> })?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const parts = candidates[0]?.content?.parts
  if (!Array.isArray(parts)) return []
  return parts
    .filter((p): p is { functionCall: { name: string; args: Record<string, unknown> } } => !!p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args }))
}

function toGeminiHistory(history: Array<{ role: "user" | "assistant"; content: string }>) {
  return history.map((h) => ({
    role: h.role === "assistant" ? "model" as const : "user" as const,
    parts: [{ text: h.content }]
  }))
}

/** Relaxed safety settings — users are editing their own site content */
const PERMISSIVE_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
] as const

// ---------------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------------

export async function parseIntentWithGemini(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
}): Promise<ParsedIntent> {
  const ai = await getGeminiClient()
  const system = buildIntentParserSystemPrompt()

  const user = {
    request: args.message,
    slug: args.slug,
    activeBlockId: args.activeBlockId ?? null,
    activeBlockType: args.activeBlockType ?? null,
    activeEditablePath: args.activeEditablePath ?? null,
    availableBlockTypes: allowedBlockTypes,
    blocks: args.currentPage.blocks.map((b) => ({ id: b.id, type: b.type, props: Object.keys(b.props) }))
  }

  const response = await ai.models.generateContent({
    model: args.model,
    contents: JSON.stringify(user),
    config: {
      systemInstruction: system,
      responseMimeType: "application/json",
      responseJsonSchema: intentJsonSchema,
      temperature: 0,
      safetySettings: PERMISSIVE_SAFETY_SETTINGS,
    }
  })

  const raw = extractGeminiText(response)
  if (!raw.trim()) throw new Error("Intent parser did not return JSON")

  const normalized = JSON.parse(raw) as Record<string, unknown>

  // Nulls from the schema become undefined for Zod optional fields
  for (const key of Object.keys(normalized)) {
    if (normalized[key] === null) delete normalized[key]
  }

  const parsed = intentSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const detail = issue?.message ?? "Invalid intent parser output"
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`${detail}${at}`)
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

export async function generatePlanWithGemini(args: {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof plannerContextPack>
  model: string
  history?: Array<{ role: "user" | "assistant"; content: string }>
  feedback?: string
  onToken?: (token: string) => void
  onFieldDraft?: (draft: { blockId: string; editablePath: string; value: string }) => void
  onPlannedOp?: (op: Operation, index: number) => void
  onSummaryChunk?: (text: string) => void
  onChangeLogEntry?: (entry: string) => void
  onToolExecution?: (event: ToolExecutionEvent) => void
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
  toolRuntime?: ToolRuntime
  toolCallContext?: { siteId: string; sessionId: string; userId?: string; traceId: string; gdriveFolderId?: string }
  siteContextBlock?: string | null
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
  forceFullSchemaContracts?: boolean
  componentsManifest?: BlockManifest
  lightweight?: boolean
  signal?: AbortSignal
  locale?: string
}): Promise<{ plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta; deferredNativeImageCalls?: DeferredNativeImageCall[] }> {
  const ai = await getGeminiClient()
  const effectiveBlockTypes = args.componentsManifest ? args.componentsManifest.blocks.map(c => c.type) : allowedBlockTypes
  const batchOverride = isBatchAddRequest(args.message) || isBatchRemoveRequest(args.message) || isBatchReorderRequest(args.message) || isPageWideRewriteRequest(args.message)
  const pageWideRewrite = isPageWideRewriteRequest(args.message)
  const pageWideTranslation = isPageWideTranslationRequest(args.message)
  const chatStrictPrimaryOpMode = isChatStrictPrimaryOpMode() && !batchOverride && !pageWideTranslation
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const audienceHint = extractAudienceTarget(args.message)
  const explicitOtherReference =
    selectedBlockId.length > 0 &&
    Array.isArray(args.contextPack.resolvedReferences.mentionedBlocks) &&
    args.contextPack.resolvedReferences.mentionedBlocks.some(
      (entry) => entry && typeof entry === "object" && "id" in entry && (entry as { id?: unknown }).id !== selectedBlockId
    )

  const system = buildPlannerSystemPrompt({
    provider: "gemini",
    lightweight: !!args.lightweight,
    selectedBlockId,
    explicitOtherReference: !!explicitOtherReference,
    chatStrictPrimaryOpMode,
    pageWideTranslation,
    pageWideRewrite,
    effectiveBlockTypes,
    siteContextBlock: args.siteContextBlock,
    imageUrlForVision: args.contextPack.selected?.imageUrlForVision,
    editablePath: args.contextPack.selected?.editablePath,
    blockId: args.contextPack.selected?.blockId,
    locale: args.locale,
    demoMode: isDemoModeEnabled(),
  })

  const includeContracts =
    !args.lightweight && (
      batchOverride ||
      pageWideTranslation ||
      /\b(create|add|insert|build|generate)\b/.test(args.message.toLowerCase()) ||
      /\b(seo|meta|metadata|og\s*image|open\s*graph|description|structured\s*data|schema\.org)\b/.test(args.message.toLowerCase()) ||
      /\d{2,3}\s*char/i.test(args.message)
    )
  const schemaContext = args.lightweight
    ? {
        payload: {} as Record<string, unknown>,
        meta: {
          contractMode: "minimal" as PlannerContractMode,
          contractBytes: 0,
          contractBlockCount: 0,
          targetBlockTypes: [] as string[],
          strictJsonEnabled: false
        }
      }
    : buildPlannerSchemaContext({
        message: args.message,
        contextPack: args.contextPack,
        batchOverride,
        pageWideTranslation,
        legacyIncludeContracts: includeContracts,
        forceFullContracts: args.forceFullSchemaContracts,
        componentsManifest: args.componentsManifest
      })

  const userPayload = {
    request: args.message,
    audienceHint: audienceHint ?? null,
    slug: args.slug,
    contextPack: args.contextPack,
    ...schemaContext.payload,
    feedback: args.feedback ?? null
  }

  // Vision support
  const imageUrlForVision = typeof args.contextPack.selected?.imageUrlForVision === "string"
    ? args.contextPack.selected.imageUrlForVision
    : null
  const imageBase64 = imageUrlForVision ? await fetchImageAsBase64(imageUrlForVision) : null

  // Build user content parts
  const userParts: Array<Record<string, unknown>> = []
  if (imageBase64) {
    userParts.push({ inlineData: { mimeType: imageBase64.mediaType, data: imageBase64.base64 } })
  }
  userParts.push({ text: JSON.stringify(userPayload) })

  // Build contents array (history + current message)
  const contents = [
    ...toGeminiHistory(args.history ?? []),
    { role: "user" as const, parts: userParts }
  ]

  // -----------------------------------------------------------------------
  // Tool runtime path — function calling with agentic loop
  // -----------------------------------------------------------------------

  const hasRuntimeTools = args.toolRuntime && args.toolCallContext
  const deferredNativeImageCalls: DeferredNativeImageCall[] = []

  if (hasRuntimeTools) {
    const raw = await runToolLoop({
      ai,
      model: args.model,
      system,
      contents,
      toolRuntime: args.toolRuntime!,
      toolCallContext: args.toolCallContext!,
      onToken: args.onToken,
      onToolExecution: args.onToolExecution,
      onStatusUpdate: args.onStatusUpdate,
      onImageProgress: args.onImageProgress,
      deferredNativeImageCalls,
      log: args.log,
    })

    const result = parseAndValidatePlan(raw, args, chatStrictPrimaryOpMode, schemaContext)
    return {
      ...result,
      deferredNativeImageCalls: deferredNativeImageCalls.length > 0 ? deferredNativeImageCalls : undefined
    }
  }

  // -----------------------------------------------------------------------
  // JSON mode path — streaming or non-streaming (like OpenAI planner)
  // -----------------------------------------------------------------------

  let raw = ""
  let usage: TokenUsage = { ...ZERO_USAGE }

  if (args.onToken) {
    // Streaming path
    let streamedOpsCount = 0
    let lastSummaryLen = 0
    let emittedChangeLogCount = 0
    const emittedFieldDraftByKey = new Map<string, string>()

    const stream = await ai.models.generateContentStream({
      model: args.model,
      contents,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: geminiEditPlanSchema,
        temperature: 0,
        safetySettings: PERMISSIVE_SAFETY_SETTINGS,
      }
    })

    for await (const chunk of stream) {
      const text = extractGeminiText(chunk)
      if (!text) continue
      raw += text
      args.onToken(text)

      // Progressive field draft extraction
      if (args.onFieldDraft) {
        const fieldDrafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
        for (const draft of fieldDrafts) {
          const key = `${draft.opIndex}:${draft.blockId}:${draft.editablePath}`
          const prev = emittedFieldDraftByKey.get(key)
          if (prev === draft.value) continue
          emittedFieldDraftByKey.set(key, draft.value)
          args.onFieldDraft({ blockId: draft.blockId, editablePath: draft.editablePath, value: draft.value })
        }
      }

      // Progressive summary + change log extraction
      if (args.onSummaryChunk || args.onChangeLogEntry) {
        const extracted = extractSummaryFromPlanBuffer(raw)
        if (extracted.summary && extracted.summary.length > lastSummaryLen) {
          args.onSummaryChunk?.(extracted.summary.slice(lastSummaryLen))
          lastSummaryLen = extracted.summary.length
        }
        for (let i = emittedChangeLogCount; i < extracted.changeLog.length; i++) {
          args.onChangeLogEntry?.(extracted.changeLog[i]!)
        }
        emittedChangeLogCount = extracted.changeLog.length
      }

      // Progressive ops extraction
      if (args.onPlannedOp) {
        const next = extractOpsFromPlanBuffer(raw, streamedOpsCount)
        streamedOpsCount = next.nextEmittedCount
        for (let idx = 0; idx < next.newOps.length; idx += 1) {
          args.onPlannedOp(next.newOps[idx]!, streamedOpsCount - next.newOps.length + idx + 1)
        }
      }

      // Extract usage from last chunk
      const chunkUsage = extractGeminiUsage(chunk)
      if (chunkUsage.totalTokens > 0) usage = chunkUsage
    }

    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
  } else {
    // Non-streaming path
    const response = await ai.models.generateContent({
      model: args.model,
      contents,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: geminiEditPlanSchema,
        temperature: 0,
        safetySettings: PERMISSIVE_SAFETY_SETTINGS,
      }
    })

    raw = extractGeminiText(response)
    usage = extractGeminiUsage(response)

    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
  }

  return parseAndValidatePlan(raw, args, chatStrictPrimaryOpMode, schemaContext, usage)
}

// ---------------------------------------------------------------------------
// Tool loop — agentic function calling for image gen, unsplash, etc.
// ---------------------------------------------------------------------------

const MAX_TOOL_TURNS = 6

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runToolLoop(args: {
  ai: any
  model: string
  system: string
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>
  toolRuntime: ToolRuntime
  toolCallContext: { siteId: string; sessionId: string; userId?: string; traceId: string; gdriveFolderId?: string }
  onToken?: (token: string) => void
  onToolExecution?: (event: ToolExecutionEvent) => void
  onStatusUpdate?: (message: string) => void
  onImageProgress?: (event: { percent: number; stage: string }) => void
  deferredNativeImageCalls: DeferredNativeImageCall[]
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
}): Promise<string> {
  // Build function declarations from tool registry + submit_edit_plan
  const runtimeManifests = args.toolRuntime.registry.listManifests()
  const functionDeclarations = [
    {
      name: "submit_edit_plan",
      description: "Submit the structured EditPlan JSON.",
      parameters: editPlanJsonSchema
    },
    ...runtimeManifests.map((m) => ({
      name: m.name.replace(/\./g, "_"), // Gemini requires alphanumeric + underscore
      description: m.description,
      parameters: m.inputSchema
    }))
  ]

  // Map aliased names back to runtime names
  const aliasToRuntimeName = new Map<string, string>()
  for (const m of runtimeManifests) {
    aliasToRuntimeName.set(m.name.replace(/\./g, "_"), m.name)
  }

  const messages = [...args.contents]
  let submitPlanJson = ""

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await args.ai.models.generateContent({
      model: args.model,
      contents: messages,
      config: {
        systemInstruction: args.system,
        temperature: 0,
        safetySettings: PERMISSIVE_SAFETY_SETTINGS,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
      }
    })

    const text = extractGeminiText(response)
    if (text && args.onToken) args.onToken(text)

    const functionCalls = extractGeminiFunctionCalls(response)
    if (functionCalls.length === 0) {
      // Model returned text instead of function call — treat as plan JSON
      return text || submitPlanJson
    }

    // Process function calls
    const toolResults: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = []

    for (const fc of functionCalls) {
      if (fc.name === "submit_edit_plan") {
        submitPlanJson = JSON.stringify(fc.args)
        toolResults.push({
          functionResponse: { name: fc.name, response: { ok: true } }
        })
        continue
      }

      const runtimeName = aliasToRuntimeName.get(fc.name) ?? fc.name
      const input = fc.args ?? {}

      // Defer image tools
      if (DEFERRABLE_IMAGE_TOOLS.has(runtimeName)) {
        const placeholder = runtimeName === "image.generate"
          ? GENERATING_IMAGE_PLACEHOLDER
          : SEARCHING_IMAGE_PLACEHOLDER
        const placeholderData = runtimeName === "image.generate"
          ? { imageUrl: placeholder, alt: String((input as Record<string, unknown>).prompt ?? "Generating image…"), width: 768, height: 512 }
          : { items: [{ id: "placeholder", imageUrl: placeholder, thumbUrl: placeholder, alt: String((input as Record<string, unknown>).query ?? "Searching…"), author: "Placeholder", sourceUrl: "" }] }
        args.deferredNativeImageCalls.push({
          toolName: runtimeName as "image.generate" | "unsplash.search",
          input,
          placeholderUrl: placeholder
        })
        toolResults.push({
          functionResponse: { name: fc.name, response: placeholderData as Record<string, unknown> }
        })
        args.onToolExecution?.({
          toolName: runtimeName,
          ok: true,
          latencyMs: 0,
          attempts: 0,
          traceId: args.toolCallContext.traceId,
          sessionId: args.toolCallContext.sessionId,
          siteId: args.toolCallContext.siteId,
          plannerProvider: "gemini",
          deferred: true
        })
        continue
      }

      // Execute runtime tool
      const startMs = Date.now()
      const result = await executeToolCall({
        runtime: args.toolRuntime,
        toolName: runtimeName,
        input,
        context: {
          siteId: args.toolCallContext.siteId,
          sessionId: args.toolCallContext.sessionId,
          userId: args.toolCallContext.userId,
          traceId: args.toolCallContext.traceId,
          plannerProvider: "gemini",
          gdriveFolderId: args.toolCallContext.gdriveFolderId,
          onStatusUpdate: args.onStatusUpdate,
          onImageProgress: args.onImageProgress,
        },
        policy: args.toolRuntime.defaultPolicy
      })
      const latencyMs = Date.now() - startMs

      args.onToolExecution?.({
        toolName: runtimeName,
        ok: result.ok,
        latencyMs,
        attempts: result.attempts,
        traceId: args.toolCallContext.traceId,
        sessionId: args.toolCallContext.sessionId,
        siteId: args.toolCallContext.siteId,
        plannerProvider: "gemini",
        ...(result.ok ? {} : { errorCode: result.error?.code })
      })

      toolResults.push({
        functionResponse: {
          name: fc.name,
          response: result.ok
            ? (typeof result.data === "object" && result.data !== null ? result.data as Record<string, unknown> : { result: result.data })
            : { error: String(result.error?.message ?? "Tool execution failed") }
        }
      })
    }

    // If we got submit_edit_plan, we're done
    if (submitPlanJson) return submitPlanJson

    // Add model response + tool results to conversation
    const modelParts = functionCalls.map((fc) => ({ functionCall: { name: fc.name, args: fc.args } }))
    messages.push({ role: "model", parts: modelParts })
    messages.push({ role: "user", parts: toolResults })
  }

  // Exhausted max turns — return whatever we have
  if (submitPlanJson) return submitPlanJson
  throw toPlannerError("incomplete_output", `Gemini tool loop exhausted ${MAX_TOOL_TURNS} turns without submitting a plan`)
}

// ---------------------------------------------------------------------------
// Shared parse + validate
// ---------------------------------------------------------------------------

function parseAndValidatePlan(
  raw: string,
  args: { slug: string; currentPage: PageDoc; message: string },
  chatStrictPrimaryOpMode: boolean,
  schemaContext: { meta: PlannerSchemaContextMeta },
  usage: TokenUsage = { ...ZERO_USAGE }
): { plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta } {
  const jsonText = extractJsonObject(raw) ?? raw
  if (!jsonText.trim()) {
    throw toPlannerError("malformed_output", "Model did not return JSON", true)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonText)
  } catch (err) {
    try {
      const meta = repairAndParseJsonWithMeta(jsonText)
      parsedJson = meta.parsed
      if (meta.strategy !== "none") {
        console.warn(`[gemini-planner] JSON repaired via ${meta.strategy}${meta.mutationCount ? ` (${meta.mutationCount} mutations)` : ""}${meta.discardedBytes ? ` (${meta.discardedBytes}B discarded)` : ""}`)
      }
    } catch {
      const posMatch = err instanceof SyntaxError ? /position (\d+)/i.exec(err.message) : null
      const pos = posMatch?.[1]
      const snippet = pos ? jsonText.slice(Math.max(0, Number(pos) - 30), Number(pos) + 30) : jsonText.slice(0, 200)
      throw toPlannerError("malformed_output", `Model returned malformed JSON: ${(err as Error).message}. Near: …${snippet}…`, true)
    }
  }

  const rawCandidateResult = rawPlanCandidateSchema.safeParse(parsedJson)
  if (!rawCandidateResult.success) {
    const first = rawCandidateResult.error.issues[0]
    const at = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const detail = first?.message ?? "Raw planner output shape is invalid"
    throw toPlannerError("malformed_output", `${detail}${at}`, true)
  }

  const parsed = normalizePlanCandidate(rawCandidateResult.data, {
    defaultSlug: args.slug,
    currentPage: args.currentPage,
    userMessage: args.message
  })
  const planResult = editPlanSchema.safeParse(parsed)
  if (!planResult.success) {
    const first = planResult.error.issues[0]
    const message = first?.message ?? "Invalid model output"
    const path = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const sample = JSON.stringify(parsed).slice(0, 700)
    throw toPlannerError("schema_violation", `${message}${path}. Parsed sample: ${sample}`, true)
  }

  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      plan: { ...planResult.data, ops: [planResult.data.ops[0]] },
      usage,
      schemaContext: schemaContext.meta
    }
  }
  return { plan: planResult.data, usage, schemaContext: schemaContext.meta }
}
