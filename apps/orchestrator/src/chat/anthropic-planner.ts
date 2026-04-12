import Anthropic from "@anthropic-ai/sdk"
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
import { GENERATING_IMAGE_PLACEHOLDER, SEARCHING_IMAGE_PLACEHOLDER } from "./chat-pipeline.js"
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
  normalizeOpName,
  normalizePlanCandidate,
  repairJson,
  repairAndParseJson,
  repairAndParseJsonWithMeta
} from "../nlp/plan-normalizer.js"
import {
  buildPlannerSchemaContext,
  extractUpdatePropsFieldDraftsFromPlanBuffer,
  extractOpsFromPlanBuffer,
  extractSummaryFromPlanBuffer,
  isChatStrictPrimaryOpMode,
  isPageWideTranslationRequest,
  type PlannerSchemaContextMeta
} from "./planner.js"
import { editPlanJsonSchema, intentJsonSchema } from "./plan-json-schema.js"
import { type TokenUsage, extractUsage, ZERO_USAGE } from "../telemetry/usage.js"
import { anthropicSystemPromptWithCache, anthropicToolWithCache, ANTHROPIC_FINE_GRAINED_STREAM_HEADERS } from "./anthropic-cache.js"
import { executeToolCall, type ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"

import { type DeferredNativeImageCall, DEFERRABLE_IMAGE_TOOLS } from "./chat-pipeline-shared.js"
// Re-export so existing importers (chat-pipeline.ts) don't break
export type { DeferredNativeImageCall }

// Minimum text length to treat a text-only model response as meaningful
// content (rather than discarding it in favor of the hardcoded fallback).
const MIN_MEANINGFUL_RESPONSE_LENGTH = 20

/** Detect API-level errors (rate limits, auth failures, quota exhaustion) that
 *  should NOT be treated as recoverable stream parse errors. */
function isApiLevelError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes("usage limit") ||
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid.*api.*key") ||
    msg.includes("billing") ||
    /\b40[0-13]\b/.test(err.message)
  )
}

/**
 * Try JSON.parse, then repairAndParseJson. Returns parsed object or null.
 */
function tryParseOrRepair(buf: string, log?: { warn: (obj: Record<string, unknown>, msg: string) => void }, model?: string): Record<string, unknown> | null {
  try {
    return JSON.parse(buf) as Record<string, unknown>
  } catch {
    try {
      const meta = repairAndParseJsonWithMeta(buf)
      log?.warn({ event: "anthropic_planner_json_repaired", model: model ?? "unknown", strategy: meta.strategy, mutationCount: meta.mutationCount, discardedBytes: meta.discardedBytes }, "Anthropic planner: repaired malformed tool JSON from stream buffer")
      return meta.parsed as Record<string, unknown>
    } catch (repairErr) {
      log?.warn({
        event: "anthropic_planner_repair_failed",
        model: model ?? "unknown",
        repairError: repairErr instanceof Error ? repairErr.message : String(repairErr),
      }, "Anthropic planner: repairAndParseJson failed")
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton Anthropic client — reuses HTTP/2 connection pool across requests.
// Lazily initialized on first use so module-level import doesn't throw if
// ANTHROPIC_API_KEY isn't set yet.
// ---------------------------------------------------------------------------
let _anthropicSingleton: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (!_anthropicSingleton) {
    _anthropicSingleton = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _anthropicSingleton
}

/** Reset the singleton (useful for tests that swap API keys). */
export function resetAnthropicClient() {
  _anthropicSingleton = null
}


export async function parseIntentWithAnthropic(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
}): Promise<ParsedIntent> {
  const client = getAnthropicClient()
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

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 2048,
    system: anthropicSystemPromptWithCache(system),
    output_config: {
      format: { type: "json_schema", schema: intentJsonSchema }
    },
    messages: [
      { role: "user", content: JSON.stringify(user) }
    ],
  })

  if (response.stop_reason === "max_tokens") {
    const textBlock = response.content.find((b) => b.type === "text")
    const raw = textBlock && "text" in textBlock ? textBlock.text : ""
    args.log?.warn({
      event: "anthropic_intent_truncated",
      model: args.model,
      stopReason: response.stop_reason,
      rawPreview: raw.slice(0, 500)
    }, "Anthropic intent parser: response truncated (max_tokens)")
    throw new Error("Intent parser response was truncated (max_tokens reached)")
  }
  const textBlock = response.content.find((b) => b.type === "text")
  const raw = textBlock && "text" in textBlock ? textBlock.text : ""
  if (!raw.trim()) {
    args.log?.warn({
      event: "anthropic_intent_no_json",
      model: args.model,
      stopReason: response.stop_reason ?? "unknown",
      rawPreview: raw.slice(0, 500),
      contentBlockTypes: response.content.map((b) => b.type)
    }, "Anthropic intent parser: model returned empty response")
    throw new Error("Intent parser did not return JSON")
  }
  // output_config guarantees valid JSON matching our schema — parse directly
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

export type PlannerAnthropicClient = {
  messages: {
    create: (args: unknown) => Promise<Anthropic.Messages.Message>
    stream?: (
      args: unknown,
      options?: { headers?: Record<string, string> }
    ) => AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> }
  }
}

function sumTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) }
      : {}),
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
      : {})
  }
}

function asToolUseBlock(block: Anthropic.Messages.ContentBlock) {
  if (block.type !== "tool_use") return null
  return block as unknown as { type: "tool_use"; id: string; name: string; input: unknown }
}

function toAnthropicToolAlias(name: string, used: Set<string>) {
  let alias = name.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (!alias) alias = "tool"
  if (/^[0-9]/.test(alias)) alias = `tool_${alias}`
  alias = alias.slice(0, 120)
  let unique = alias
  let counter = 1
  while (used.has(unique)) {
    unique = `${alias}_${counter}`
    counter += 1
  }
  used.add(unique)
  return unique
}

export async function generatePlanWithAnthropic(args: {
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
  client?: PlannerAnthropicClient
  siteContextBlock?: string | null
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
  forceFullSchemaContracts?: boolean
  componentsManifest?: BlockManifest
  lightweight?: boolean
  signal?: AbortSignal
  locale?: string
}): Promise<{ plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta; deferredNativeImageCalls?: DeferredNativeImageCall[] }> {
  const client = args.client ?? (getAnthropicClient() as unknown as PlannerAnthropicClient)
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
    provider: "anthropic",
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

  const lowerMsg = args.message.toLowerCase()
  const includeContracts =
    !args.lightweight && (
      batchOverride ||
      pageWideTranslation ||
      /\b(create|add|insert|build|generate)\b/.test(lowerMsg) ||
      /\b(seo|meta|metadata|og\s*image|open\s*graph|description|structured\s*data|schema\.org)\b/.test(lowerMsg) ||
      /\d{2,3}\s*char/i.test(args.message) ||
      // Multi-field updates need block contracts to know valid prop names
      (lowerMsg.match(/['''"""\u201C\u201D\u2018\u2019]/g)?.length ?? 0) >= 4
    )
  const schemaContext = args.lightweight
    ? {
        payload: {} as ReturnType<typeof buildPlannerSchemaContext>["payload"],
        meta: {
          contractMode: "minimal" as const,
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

  const user = {
    request: args.message,
    audienceHint: audienceHint ?? null,
    slug: args.slug,
    contextPack: args.contextPack,
    ...schemaContext.payload,
    feedback: args.feedback ?? null
  }

  const imageUrlForVision = typeof args.contextPack.selected?.imageUrlForVision === "string"
    ? args.contextPack.selected.imageUrlForVision
    : null
  const imageBase64 = imageUrlForVision ? await fetchImageAsBase64(imageUrlForVision) : null
  const userContent: Anthropic.MessageParam["content"] = imageUrlForVision
    ? [
        imageBase64
          ? { type: "image" as const, source: { type: "base64" as const, media_type: imageBase64.mediaType as "image/jpeg", data: imageBase64.base64 } }
          : { type: "image" as const, source: { type: "url" as const, url: imageUrlForVision } },
        { type: "text" as const, text: JSON.stringify(user) }
      ]
    : JSON.stringify(user)

  const historyMessages: Anthropic.MessageParam[] = (args.history ?? []).map((h) => ({
    role: h.role as "user" | "assistant",
    content: h.content
  }))

  const submitPlanToolDef: Anthropic.Messages.Tool = {
    name: "submit_edit_plan",
    description: "Submit the structured EditPlan JSON.",
    input_schema: editPlanJsonSchema,
    eager_input_streaming: true
  }
  const runtimeToolNameByAlias = new Map<string, string>()
  const usedAliases = new Set<string>(["submit_edit_plan"])
  const runtimeTools: Anthropic.Messages.Tool[] =
    args.toolRuntime
      ? args.toolRuntime.registry.listEnabled().map((entry) => {
          const alias = toAnthropicToolAlias(entry.manifest.name, usedAliases)
          runtimeToolNameByAlias.set(alias, entry.manifest.name)
          return {
            name: alias,
            description: entry.manifest.description,
            input_schema: entry.manifest.inputSchema as unknown as { type: "object" }
          }
        })
      : []
  // Anthropic allows max 4 cache_control breakpoints total. Apply only to the last tool
  // (system prompt already uses one breakpoint via anthropicSystemPromptWithCache).
  const toolDefs: Anthropic.Messages.Tool[] = [submitPlanToolDef, ...runtimeTools].map((tool, i, arr) =>
    i === arr.length - 1 ? anthropicToolWithCache(tool) : tool
  )

  let parsed: Record<string, unknown> | undefined
  let usage: TokenUsage = { ...ZERO_USAGE }
  const deferredNativeImageCalls: DeferredNativeImageCall[] = []
  let streamedOpsCount = 0
  let lastSummaryLen = 0
  let emittedChangeLogCount = 0
  const emittedFieldDraftByKey = new Map<string, string>()
  const maxToolTurns = 6
  const emitProgressFromToolJson = (toolJsonBuf: string) => {
    if (args.onFieldDraft) {
      const fieldDrafts = extractUpdatePropsFieldDraftsFromPlanBuffer(toolJsonBuf)
      for (const draft of fieldDrafts) {
        const key = `${draft.opIndex}:${draft.blockId}:${draft.editablePath}`
        const prev = emittedFieldDraftByKey.get(key)
        if (prev === draft.value) continue
        emittedFieldDraftByKey.set(key, draft.value)
        args.onFieldDraft({ blockId: draft.blockId, editablePath: draft.editablePath, value: draft.value })
      }
    }
    if (args.onSummaryChunk || args.onChangeLogEntry) {
      const extracted = extractSummaryFromPlanBuffer(toolJsonBuf)
      if (extracted.summary && extracted.summary.length > lastSummaryLen) {
        args.onSummaryChunk?.(extracted.summary.slice(lastSummaryLen))
        lastSummaryLen = extracted.summary.length
      }
      for (let i = emittedChangeLogCount; i < extracted.changeLog.length; i++) {
        args.onChangeLogEntry?.(extracted.changeLog[i]!)
      }
      emittedChangeLogCount = extracted.changeLog.length
    }
    if (args.onPlannedOp) {
      const next = extractOpsFromPlanBuffer(toolJsonBuf, streamedOpsCount)
      streamedOpsCount = next.nextEmittedCount
      for (let idx = 0; idx < next.newOps.length; idx += 1) {
        args.onPlannedOp(next.newOps[idx]!, streamedOpsCount - next.newOps.length + idx + 1)
      }
    }
  }

  if (runtimeTools.length > 0) {
    const loopMessages: Anthropic.MessageParam[] = [
      ...historyMessages,
      { role: "user", content: userContent }
    ]

    for (let turn = 0; turn < maxToolTurns; turn += 1) {
      let response: Anthropic.Messages.Message
      let emittedTextDeltas = false
      if (client.messages.stream) {
        const stream = client.messages.stream({
          model: args.model,
          max_tokens: 8192,
          system: anthropicSystemPromptWithCache(system),
          tools: toolDefs,
          tool_choice: { type: "auto" },
          messages: loopMessages
        }, {
          headers: ANTHROPIC_FINE_GRAINED_STREAM_HEADERS
        })
        const toolNameByIndex = new Map<number, string>()
        const submitToolJsonByIndex = new Map<number, string>()
        let path1TextBuf = ""
        // Wrap stream iteration — SDK may throw on message_stop if tool JSON is malformed
        let path1StreamError: unknown
        try {
          for await (const event of stream as AsyncIterable<{
            type?: string
            index?: number
            content_block?: { type?: string; name?: string }
            delta?: { type?: string; partial_json?: string; text?: string }
          }>) {
            if (event.type === "content_block_start") {
              const idx = typeof event.index === "number" ? event.index : -1
              if (idx >= 0 && event.content_block?.type === "tool_use" && typeof event.content_block.name === "string") {
                toolNameByIndex.set(idx, event.content_block.name)
              }
              continue
            }
            if (event.type !== "content_block_delta") continue
            if (event.delta?.type === "text_delta") {
              const text = event.delta.text ?? ""
              if (text.length > 0) {
                emittedTextDeltas = true
                path1TextBuf += text
                args.onToken?.(text)
              }
              continue
            }
            if (event.delta?.type !== "input_json_delta") continue
            const idx = typeof event.index === "number" ? event.index : -1
            if (idx < 0 || toolNameByIndex.get(idx) !== "submit_edit_plan") continue
            const nextBuf = (submitToolJsonByIndex.get(idx) ?? "") + (event.delta.partial_json ?? "")
            submitToolJsonByIndex.set(idx, nextBuf)
            emitProgressFromToolJson(nextBuf)
          }
        } catch (err) {
          // Re-throw API-level errors (rate limits, auth failures, quota exhaustion)
          // instead of treating them as recoverable stream parse errors.
          if (isApiLevelError(err)) throw err
          path1StreamError = err
        }

        // If stream threw, try to parse from accumulated buffers instead of finalMessage
        if (path1StreamError) {
          args.log?.warn({
            event: "anthropic_path1_stream_loop_error",
            model: args.model,
            error: path1StreamError instanceof Error ? path1StreamError.message : String(path1StreamError),
            submitToolJsonEntries: submitToolJsonByIndex.size,
            textBufLength: path1TextBuf.length,
          }, "Anthropic Path 1: stream loop threw (SDK JSON parse) — will attempt buffer repair")

          // Find the submit_edit_plan buffer and attempt repair
          for (const [idx, buf] of submitToolJsonByIndex) {
            if (toolNameByIndex.get(idx) === "submit_edit_plan" && buf.length > 0) {
              parsed = tryParseOrRepair(buf, args.log, args.model) ?? undefined
              if (parsed) break
            }
          }
          if (parsed) break
          // Buffer repair failed. If we accumulated meaningful text, use it as
          // an info response rather than falling through to the hardcoded fallback.
          if (path1TextBuf.trim().length > MIN_MEANINGFUL_RESPONSE_LENGTH) {
            return {
              plan: {
                intent: "needs_clarification",
                summary_for_user: path1TextBuf.trim(),
                change_log: [],
                ops: []
              },
              usage,
              schemaContext: schemaContext.meta
            }
          }
          // If we couldn't parse, build a synthetic response to let the outer logic handle it
          response = { content: [], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Messages.Message
        } else {
          const finalMessage = await stream.finalMessage()
          response = finalMessage as Anthropic.Messages.Message
        }
      } else {
        response = await client.messages.create({
          model: args.model,
          max_tokens: 8192,
          system: anthropicSystemPromptWithCache(system),
          tools: toolDefs,
          tool_choice: { type: "auto" },
          messages: loopMessages
        })
      }
      usage = sumTokenUsage(usage, extractUsage(response))

      if ((response as { stop_reason?: string }).stop_reason === "max_tokens") {
        args.log?.warn({
          event: "anthropic_planner_truncated",
          model: args.model,
          stopReason: "max_tokens",
          turn,
          contentBlockTypes: response.content.map((b) => b.type)
        }, "Anthropic planner: response truncated (max_tokens) during tool loop")
        throw new Error("Model response was truncated (max_tokens reached)")
      }

      if (args.onToken && !emittedTextDeltas) {
        for (const block of response.content) {
          if (block.type === "text" && "text" in block && typeof block.text === "string") {
            args.onToken(block.text)
          }
        }
      }

      const submitToolUse = response.content
        .map((block) => asToolUseBlock(block))
        .find((block) => block?.name === "submit_edit_plan")
      if (submitToolUse && submitToolUse.input && typeof submitToolUse.input === "object") {
        parsed = submitToolUse.input as Record<string, unknown>
        break
      }

      const runtimeToolCalls = response.content
        .map((block) => asToolUseBlock(block))
        .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => Boolean(block && block.name !== "submit_edit_plan"))
      if (runtimeToolCalls.length === 0) {
        const textBlock = response.content.find((block) => block.type === "text")
        const raw = textBlock && "text" in textBlock ? textBlock.text : ""
        const jsonText = extractJsonObject(raw)
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText) as Record<string, unknown>
          } catch {
            try {
              const meta = repairAndParseJsonWithMeta(jsonText)
              parsed = meta.parsed as Record<string, unknown>
              args.log?.warn({ event: "anthropic_planner_json_repaired", model: args.model, strategy: meta.strategy, mutationCount: meta.mutationCount, discardedBytes: meta.discardedBytes }, "Anthropic planner: repaired malformed text-block JSON (non-streaming tool loop)")
            } catch { /* fall through */ }
          }
          if (parsed) break
        }
        // Model responded with text only (no tool call). If we have meaningful
        // text content, treat it as an "info" response rather than discarding it.
        const trimmed = raw.trim()
        if (trimmed.length > MIN_MEANINGFUL_RESPONSE_LENGTH) {
          return {
            plan: {
              intent: "needs_clarification",
              summary_for_user: trimmed,
              change_log: [],
              ops: []
            },
            usage,
            schemaContext: schemaContext.meta
          }
        }
        return {
          plan: {
            intent: "needs_clarification",
            summary_for_user: "I'm not sure what to do with that. You can try:",
            change_log: [],
            ops: [],
            suggested_next_actions: [
              "Create a new page",
              "Add a section to the page",
              "Rewrite the copy",
              "Change the images"
            ]
          },
          usage,
          schemaContext: schemaContext.meta
        }
      }

      loopMessages.push({ role: "assistant", content: response.content })

      const toolResults: Array<{
        type: "tool_result"
        tool_use_id: string
        content: string
        is_error?: boolean
      }> = []

      for (const toolCall of runtimeToolCalls) {
        const input = "input" in toolCall ? toolCall.input : {}
        const runtimeToolName = runtimeToolNameByAlias.get(toolCall.name) ?? toolCall.name

        // Defer slow image tools — return a placeholder so text ops stream immediately
        if (DEFERRABLE_IMAGE_TOOLS.has(runtimeToolName)) {
          const placeholderUrl = runtimeToolName === "image.generate"
            ? GENERATING_IMAGE_PLACEHOLDER
            : SEARCHING_IMAGE_PLACEHOLDER
          const placeholderData = runtimeToolName === "image.generate"
            ? { imageUrl: placeholderUrl, alt: String((input as Record<string, unknown>).prompt ?? "Generating image…"), width: 768, height: 512 }
            : { items: [{ id: "placeholder", imageUrl: placeholderUrl, thumbUrl: placeholderUrl, alt: String((input as Record<string, unknown>).query ?? "Searching…"), author: "Placeholder", sourceUrl: "" }] }

          deferredNativeImageCalls.push({
            toolName: runtimeToolName as "image.generate" | "unsplash.search",
            input: input as Record<string, unknown>,
            placeholderUrl
          })
          args.onToolExecution?.({
            toolName: runtimeToolName,
            ok: true,
            latencyMs: 0,
            attempts: 0,
            traceId: args.toolCallContext?.traceId ?? "tool-call",
            sessionId: args.toolCallContext?.sessionId ?? "dev",
            siteId: args.toolCallContext?.siteId ?? "default",
            plannerProvider: "anthropic",
            deferred: true
          })
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: JSON.stringify(placeholderData)
          })
          continue
        }

        const result = await executeToolCall({
          runtime: args.toolRuntime!,
          toolName: runtimeToolName,
          input,
          context: {
            siteId: args.toolCallContext?.siteId ?? "default",
            sessionId: args.toolCallContext?.sessionId ?? "dev",
            userId: args.toolCallContext?.userId,
            traceId: args.toolCallContext?.traceId ?? "tool-call",
            plannerProvider: "anthropic",
            gdriveFolderId: args.toolCallContext?.gdriveFolderId,
            onStatusUpdate: args.onStatusUpdate,
            onImageProgress: args.onImageProgress
          },
          policy: args.toolRuntime?.defaultPolicy
        })
        args.onToolExecution?.({
          toolName: runtimeToolName,
          ok: result.ok,
          latencyMs: result.latencyMs,
          attempts: result.attempts,
          errorCode: result.error?.code,
          traceId: args.toolCallContext?.traceId ?? "tool-call",
          sessionId: args.toolCallContext?.sessionId ?? "dev",
          siteId: args.toolCallContext?.siteId ?? "default",
          plannerProvider: "anthropic"
        })
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: JSON.stringify(result.ok ? result.data : { error: result.error }),
          ...(result.ok ? {} : { is_error: true })
        })
      }

      loopMessages.push({
        role: "user",
        content: toolResults as unknown as string
      } as unknown as Anthropic.MessageParam)
    }
  } else if (args.onToken) {
    let toolJsonBuf = ""
    let textBuf = ""
    if (client.messages.stream) {
      const stream = client.messages.stream({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        tools: [anthropicToolWithCache(submitPlanToolDef)],
        tool_choice: { type: "tool", name: "submit_edit_plan" },
        messages: [
          ...historyMessages,
          { role: "user", content: userContent }
        ],
      }, {
        headers: ANTHROPIC_FINE_GRAINED_STREAM_HEADERS
      })
      // Wrap stream iteration — SDK may throw on message_stop if tool JSON is malformed
      let streamLoopError: unknown
      try {
        for await (const event of stream as AsyncIterable<{
          type?: string
          delta?: { type?: string; partial_json?: string; text?: string }
        }>) {
          if (event.type === "content_block_delta") {
            if (event.delta?.type === "input_json_delta") {
              toolJsonBuf += event.delta.partial_json ?? ""
              emitProgressFromToolJson(toolJsonBuf)
            } else if (event.delta?.type === "text_delta") {
              textBuf += event.delta.text ?? ""
              args.onToken(event.delta.text ?? "")
            }
          }
        }
      } catch (err) {
        if (isApiLevelError(err)) throw err
        streamLoopError = err
        args.log?.warn({
          event: "anthropic_path2_stream_loop_error",
          model: args.model,
          error: err instanceof Error ? err.message : String(err),
          toolJsonBufLength: toolJsonBuf.length,
          toolJsonBufPreview: toolJsonBuf.slice(0, 500),
        }, "Anthropic Path 2: stream loop threw (SDK JSON parse) — will attempt toolJsonBuf repair")
      }

      // If stream completed normally, try finalMessage() for validated tool input.
      // Skip if stream threw — finalMessage() would also fail.
      if (!streamLoopError) {
        let finalMessage: Anthropic.Messages.Message | undefined
        try {
          finalMessage = await stream.finalMessage() as Anthropic.Messages.Message
          usage = extractUsage(finalMessage)

          const streamStopReason = (finalMessage as { stop_reason?: string })?.stop_reason
          if (streamStopReason === "max_tokens") {
            args.log?.warn({
              event: "anthropic_planner_truncated",
              model: args.model,
              stopReason: streamStopReason,
              toolJsonBufLength: toolJsonBuf.length,
              textBufLength: textBuf.length
            }, "Anthropic planner: response truncated (max_tokens)")
            throw new Error("Model response was truncated (max_tokens reached)")
          }

          const finalToolBlock = (finalMessage as Anthropic.Messages.Message).content
            ?.map((block) => asToolUseBlock(block))
            .find((block) => block?.name === "submit_edit_plan")

          if (finalToolBlock?.input && typeof finalToolBlock.input === "object") {
            parsed = finalToolBlock.input as Record<string, unknown>
          }
        } catch (finalMsgErr) {
          if (finalMsgErr instanceof Error && finalMsgErr.message.includes("max_tokens")) throw finalMsgErr
          args.log?.warn({
            event: "anthropic_planner_final_message_failed",
            model: args.model,
            error: finalMsgErr instanceof Error ? finalMsgErr.message : String(finalMsgErr),
            toolJsonBufLength: toolJsonBuf.length,
          }, "Anthropic planner: finalMessage() threw — falling back to streamed buffer repair")
        }
      }

      // Fallback: streamed buffer + repair (if finalMessage didn't yield tool input)
      if (!parsed && toolJsonBuf.length > 0) {
        parsed = tryParseOrRepair(toolJsonBuf, args.log, args.model) ?? undefined
      }
      if (!parsed && textBuf.length > 0) {
        const jsonText = extractJsonObject(textBuf)
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText) as Record<string, unknown>
          } catch {
            try {
              const meta = repairAndParseJsonWithMeta(jsonText)
              parsed = meta.parsed as Record<string, unknown>
              args.log?.warn({ event: "anthropic_planner_json_repaired", model: args.model, strategy: meta.strategy, mutationCount: meta.mutationCount, discardedBytes: meta.discardedBytes }, "Anthropic planner: repaired malformed text-block JSON (streaming)")
            } catch { /* fall through to non-parsed state */ }
          }
        }
      }
    } else {
      const response = await client.messages.create({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        tools: [anthropicToolWithCache(submitPlanToolDef)],
        tool_choice: { type: "tool", name: "submit_edit_plan" },
        messages: [
          ...historyMessages,
          { role: "user", content: userContent }
        ],
      })
      usage = extractUsage(response)
      if (response.stop_reason === "max_tokens") {
        args.log?.warn({
          event: "anthropic_planner_truncated",
          model: args.model,
          stopReason: response.stop_reason,
          contentBlockTypes: response.content.map((b) => b.type)
        }, "Anthropic planner: response truncated (max_tokens)")
        throw new Error("Model response was truncated (max_tokens reached)")
      }
      const toolBlock = response.content.find((b) => b.type === "tool_use")
      if (toolBlock && "input" in toolBlock && toolBlock.input && typeof toolBlock.input === "object") {
        parsed = toolBlock.input as Record<string, unknown>
      } else {
        const textBlock = response.content.find((b) => b.type === "text")
        const raw = textBlock && "text" in textBlock ? textBlock.text : ""
        const jsonText = extractJsonObject(raw)
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText) as Record<string, unknown>
          } catch {
            try {
              const meta = repairAndParseJsonWithMeta(jsonText)
              parsed = meta.parsed as Record<string, unknown>
              args.log?.warn({ event: "anthropic_planner_json_repaired", model: args.model, strategy: meta.strategy, mutationCount: meta.mutationCount, discardedBytes: meta.discardedBytes }, "Anthropic planner: repaired malformed text-block JSON (non-streaming)")
            } catch { /* fall through */ }
          }
        }
      }
    }
  } else {
    // No runtime tools — try output_config.format for constrained decoding first,
    // then fall back to tool_choice if the model doesn't return parseable JSON
    // (some models like Haiku 4.5 may not reliably support output_config).
    try {
      const response = await client.messages.create({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        output_config: {
          format: { type: "json_schema", schema: editPlanJsonSchema }
        },
        messages: [
          ...historyMessages,
          { role: "user", content: userContent }
        ],
      })
      usage = extractUsage(response)

      if (response.stop_reason === "max_tokens") {
        args.log?.warn({
          event: "anthropic_planner_truncated",
          model: args.model,
          stopReason: response.stop_reason,
          contentBlockTypes: response.content.map((b) => b.type)
        }, "Anthropic planner: response truncated (max_tokens)")
        throw new Error("Model response was truncated (max_tokens reached)")
      }

      const textBlock = response.content.find((b) => b.type === "text")
      const raw = textBlock && "text" in textBlock ? textBlock.text : ""
      if (raw.trim()) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>
        } catch {
          try {
            const meta = repairAndParseJsonWithMeta(raw)
            parsed = meta.parsed as Record<string, unknown>
            args.log?.warn({ event: "anthropic_planner_json_repaired", model: args.model, strategy: meta.strategy, mutationCount: meta.mutationCount, discardedBytes: meta.discardedBytes }, "Anthropic planner: repaired malformed output_config JSON")
          } catch { /* fall through to tool_choice fallback below */ }
        }
      }
    } catch (outputConfigErr) {
      // output_config may not be supported by this model — log and fall through
      // to the tool_choice fallback below (don't re-throw truncation errors).
      if (outputConfigErr instanceof Error && outputConfigErr.message.includes("truncated")) throw outputConfigErr
      args.log?.warn({
        event: "anthropic_planner_output_config_failed",
        model: args.model,
        error: outputConfigErr instanceof Error ? outputConfigErr.message : String(outputConfigErr)
      }, "Anthropic planner: output_config call failed, falling back to tool_choice")
    }

    // Fallback: if output_config didn't produce JSON, retry with tool_choice
    if (!parsed) {
      args.log?.warn({
        event: "anthropic_planner_output_config_fallback",
        model: args.model
      }, "Anthropic planner: output_config returned no JSON, retrying with tool_choice")
      const fallbackResponse = await client.messages.create({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        tools: [anthropicToolWithCache(submitPlanToolDef)],
        tool_choice: { type: "tool", name: "submit_edit_plan" },
        messages: [
          ...historyMessages,
          { role: "user", content: userContent }
        ],
      })
      const fallbackUsage = extractUsage(fallbackResponse)
      usage = {
        inputTokens: usage.inputTokens + fallbackUsage.inputTokens,
        outputTokens: usage.outputTokens + fallbackUsage.outputTokens,
        totalTokens: usage.totalTokens + fallbackUsage.totalTokens,
        cacheCreationInputTokens: (usage.cacheCreationInputTokens ?? 0) + (fallbackUsage.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: (usage.cacheReadInputTokens ?? 0) + (fallbackUsage.cacheReadInputTokens ?? 0)
      }

      if (fallbackResponse.stop_reason === "max_tokens") {
        throw new Error("Model response was truncated (max_tokens reached)")
      }

      const toolBlock = fallbackResponse.content.find((b) => b.type === "tool_use")
      if (toolBlock && "input" in toolBlock && toolBlock.input && typeof toolBlock.input === "object") {
        parsed = toolBlock.input as Record<string, unknown>
      } else {
        const textBlock = fallbackResponse.content.find((b) => b.type === "text")
        const raw = textBlock && "text" in textBlock ? textBlock.text : ""
        const jsonText = extractJsonObject(raw)
        if (jsonText) {
          try {
            parsed = JSON.parse(jsonText) as Record<string, unknown>
          } catch {
            try {
              const meta = repairAndParseJsonWithMeta(jsonText)
              parsed = meta.parsed as Record<string, unknown>
            } catch { /* fall through */ }
          }
        }
      }
    }
  }

  if (!parsed) {
    args.log?.warn({
      event: "anthropic_planner_no_json",
      model: args.model,
      hasHistory: (args.history?.length ?? 0) > 0,
      hasFeedback: !!args.feedback
    }, "Anthropic planner: model did not return parseable JSON")
    throw new Error(`Model did not return JSON (model=${args.model})`)
  }

  const normalized = normalizePlanCandidate(parsed, {
    defaultSlug: args.slug,
    currentPage: args.currentPage,
    userMessage: args.message
  })
  const planResult = editPlanSchema.safeParse(normalized)
  if (!planResult.success) {
    const first = planResult.error.issues[0]
    const message = first?.message ?? "Invalid model output"
    const path = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const sample = JSON.stringify(normalized).slice(0, 700)
    throw new Error(`${message}${path}. Parsed sample: ${sample}`)
  }

  const deferredImageMeta = deferredNativeImageCalls.length > 0 ? { deferredNativeImageCalls } : {}
  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      plan: {
        ...planResult.data,
        ops: [planResult.data.ops[0]]
      },
      usage,
      schemaContext: schemaContext.meta,
      ...deferredImageMeta
    }
  }
  return { plan: planResult.data, usage, schemaContext: schemaContext.meta, ...deferredImageMeta }
}
