import Anthropic from "@anthropic-ai/sdk"
import {
  allowedBlockTypes,
  blockSchemas,
  editPlanSchema,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  type ParsedIntent,
  extractAudienceTarget,
  blockContractsSummary,
  pageMetaContractSummary,
  intentSchema,
  plannerContextPack
} from "../nlp/deterministic-planner.js"
import { isBatchAddRequest, isBatchRemoveRequest } from "../nlp/intent-detection.js"
import {
  extractJsonObject,
  normalizeOpName,
  normalizePlanCandidate
} from "../nlp/plan-normalizer.js"
import { extractOpsFromPlanBuffer, isChatStrictPrimaryOpMode, isPageWideTranslationRequest } from "./planner.js"
import { editPlanJsonSchema } from "./plan-json-schema.js"
import { type TokenUsage, extractUsage, ZERO_USAGE } from "../telemetry/usage.js"
import { anthropicSystemPromptWithCache, anthropicToolWithCache } from "./anthropic-cache.js"
import { executeToolCall, type ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"


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
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const system = [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields."
  ].join("\n")

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
    messages: [
      { role: "user", content: JSON.stringify(user) }
    ],
  })

  const textBlock = response.content.find((b) => b.type === "text")
  const raw = textBlock && "text" in textBlock ? textBlock.text : ""
  if (response.stop_reason === "max_tokens") {
    args.log?.warn({
      event: "anthropic_intent_truncated",
      model: args.model,
      stopReason: response.stop_reason,
      rawPreview: raw.slice(0, 500)
    }, "Anthropic intent parser: response truncated (max_tokens)")
    throw new Error("Intent parser response was truncated (max_tokens reached)")
  }
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    args.log?.warn({
      event: "anthropic_intent_no_json",
      model: args.model,
      stopReason: response.stop_reason ?? "unknown",
      rawPreview: raw.slice(0, 500),
      contentBlockTypes: response.content.map((b) => b.type)
    }, "Anthropic intent parser: model did not return parseable JSON")
    throw new Error("Intent parser did not return JSON")
  }
  const parsedRoot = JSON.parse(jsonText) as Record<string, unknown>
  const normalized = { ...parsedRoot } as Record<string, unknown>

  if (typeof normalized.action !== "string") {
    const intent = typeof normalized.intent === "string" ? normalized.intent : undefined
    if (intent === "needs_clarification") normalized.action = "clarify"
    if (intent === "info") normalized.action = "info"
  }

  if (
    typeof normalized.action !== "string" &&
    Array.isArray(normalized.ops) &&
    normalized.ops.length > 0 &&
    normalized.ops[0] &&
    typeof normalized.ops[0] === "object"
  ) {
    const first = normalized.ops[0] as Record<string, unknown>
    const op = normalizeOpName(first.op ?? first.operation ?? first.action ?? first.kind)
    if (op === "add_block") {
      normalized.action = "add"
      const block = first.block && typeof first.block === "object" ? (first.block as Record<string, unknown>) : null
      if (block && typeof block.type === "string") normalized.new_block_type = block.type
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "bottom"
      }
      if (block && typeof block.props === "object" && block.props !== null && !Array.isArray(block.props)) {
        normalized.patch = block.props
      }
    } else if (op === "update_props") {
      normalized.action = "update"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (first.patch && typeof first.patch === "object" && !Array.isArray(first.patch)) normalized.patch = first.patch
    } else if (op === "remove_block") {
      normalized.action = "remove"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
    } else if (op === "move_block") {
      normalized.action = "move"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "top"
      }
    }
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
    stream?: (args: unknown) => AsyncIterable<unknown> & { finalMessage: () => Promise<unknown> }
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
  onPlannedOp?: (op: Operation, index: number) => void
  onToolExecution?: (event: ToolExecutionEvent) => void
  toolRuntime?: ToolRuntime
  toolCallContext?: { siteId: string; sessionId: string; userId?: string; traceId: string }
  client?: PlannerAnthropicClient
  siteContextBlock?: string | null
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
}): Promise<{ plan: EditPlan; usage: TokenUsage }> {
  const client = args.client ?? (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as PlannerAnthropicClient)
  const batchOverride = isBatchAddRequest(args.message) || isBatchRemoveRequest(args.message)
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

  const system = [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use future tense in summary_for_user and change_log — the plan has not been executed yet. Say 'Update imageUrl to…' or 'Replace the Hero image with…', not 'Updated' or 'Replaced'.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page, update_page_meta.",
    "Use update_page_meta to set SEO metadata (title, description, ogImage) on a page. Patch is merge-patch: only supplied keys update. Set a field to empty string to clear it.",
    "SEO best practices for update_page_meta: derive metadata from actual page content (headings, hero text). title: 50-60 chars, keyword-forward, relate to the H1. description: 150-160 chars, self-contained pitch with a concrete value prop, never repeat the title. ogImage: HTTPS URL, 1200x630px recommended. Never promise content that doesn't exist on the page. Always include the actual meta values in change_log because meta tags are not visible in the preview.",
    "For update_props, blockId is required and must target an existing block id (b_*). Never use a page route/path as blockId or path.",
    "Use rename_page for page route changes (pageSlug -> newPageSlug).",
    "Use remove_page when the user asks to delete a page path.",
    "Use move_page to reorder nav pages (pageSlug + optional afterPageSlug). Home (/) must stay first.",
    "For duplicate_block, blockId is required; use optional toPageSlug when duplicating into a different page.",
    "If the user specifies an audience (e.g. 'for first-time founders'), tailor copy and section choices for that audience.",
    "If user asks to create a page for an audience, create_page with audience-specific Hero/benefits/CTA content.",
    "For copy in German or similar long-compound languages, insert soft hyphen opportunities in long compounds where helpful for responsive line wrapping. Use the Unicode soft hyphen character (U+00AD), never HTML entities like &shy; or &amp;shy;.",
    "If user asks to create multiple pages (for multiple audiences or a list), include one create_page operation per requested page. Do not ask which page to create first.",
    "For create_page, derive the slug from the page name (e.g. 'Mountain Climbers' → /mountain-climbers). Never use generic slugs like /new-page.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For rewrite/rephrase requests, if contextPack.selected.block.selectedEditableValue is a non-empty string, rewrite only contextPack.selected.editablePath based on that exact selected text.",
    "If rewrite/rephrase is requested but contextPack.selected.editablePath or selected editable text is missing, return intent=needs_clarification and ask the user to select the exact text first.",
    "When rewriting text, return plain text unless the user explicitly asks for markdown formatting. Do not wrap the entire rewrite in **bold** markers.",
    "For Hero imageUrl, use any placeholder value (the system will resolve the actual image separately). If the user provides an explicit URL, use that URL. Never invent local image paths. Do NOT mention a specific image source (e.g. Unsplash) in summary_for_user — just say 'image'.",
    "For image search requests (e.g. Unsplash, stock photo, hero image replacement), call tool unsplash.search with a concise search query and choose an imageUrl from tool results.",
    "When using unsplash.search, write the selected image URL into the relevant imageUrl field and set imageAlt to a concise accessible description.",
    ...(chatStrictPrimaryOpMode
      ? [
          "Return exactly one operation in ops[].",
          "Pick the single most impactful operation for the user's request.",
          "Do not include secondary or follow-up operations."
        ]
      : [
          "When the user's request involves multiple changes, include all operations in a single plan.",
          "Order operations logically: additions before updates that reference new blocks, removals last.",
          "Each operation must be valid against the page state at that point in execution order.",
          "Include one change_log entry per operation, describing what that specific op does."
        ]),
    ...(pageWideTranslation
      ? [
          "This is a full-page translation request. Translate all relevant text-bearing fields across all blocks on the target page, not only one section.",
          "Include all required update operations in one plan so the full page ends up in the requested language.",
          "For list-based child items across all blocks (e.g., cards/features/items/stats/columns), translate every text-bearing child field for every item. Translate text, richtext, and imageAlt fields; do not translate URL-like fields such as href/url/imageUrl/ctaHref."
        ]
      : []),
    "After planning ops, include suggested_next_actions: 2-4 short imperative phrases the user could type next. Make them contextual to the planned change. For needs_clarification, suggest the most likely concrete answers.",
    "Never mention internal block IDs (b_hero_*, b_featuregrid_*, etc.), prop names (imageUrl, imageAlt), or system settings in summary_for_user or change_log. Use human-friendly descriptions instead (e.g. 'Update the Hero image' not 'Update imageUrl on b_hero_123').",
    selectedBlockId.length > 0 && !explicitOtherReference
      ? `Selected block is ${selectedBlockId}. You MUST target only this block in ops unless the user explicitly names a different section.`
      : "Respect explicit user target references when present.",
    `Allowed block types: ${allowedBlockTypes.join(", ")}.`,
    ...(args.siteContextBlock ? [`\n[site context]\n${args.siteContextBlock}\n[/site context]`] : [])
  ].join("\n")

  const includeContracts =
    batchOverride ||
    pageWideTranslation ||
    /\b(create|add|insert|build|generate)\b/.test(args.message.toLowerCase()) ||
    /\b(seo|meta|metadata|og\s*image|open\s*graph)\b/.test(args.message.toLowerCase())

  const user = {
    request: args.message,
    audienceHint: audienceHint ?? null,
    slug: args.slug,
    contextPack: args.contextPack,
    ...(includeContracts
      ? {
          blockContracts: blockContractsSummary(),
          pageMetaContract: pageMetaContractSummary(),
          knownBlockTypes: Object.keys(blockSchemas),
          editPlanShape: {
            intent: "edit_plan | needs_clarification",
            summary_for_user: "string",
            change_log: ["string"],
            ops: ["Operation[]"],
            suggested_next_actions: ["string (optional, 2-4 items)"]
          }
        }
      : {}),
    feedback: args.feedback ?? null
  }

  const historyMessages: Anthropic.MessageParam[] = (args.history ?? []).map((h) => ({
    role: h.role as "user" | "assistant",
    content: h.content
  }))

  const submitPlanToolDef: Anthropic.Messages.Tool = anthropicToolWithCache({
    name: "submit_edit_plan",
    description: "Submit the structured EditPlan JSON.",
    input_schema: editPlanJsonSchema
  })
  const runtimeToolNameByAlias = new Map<string, string>()
  const usedAliases = new Set<string>(["submit_edit_plan"])
  const runtimeTools: Anthropic.Messages.Tool[] =
    args.toolRuntime
      ? args.toolRuntime.registry.listEnabled().map((entry) => {
          const alias = toAnthropicToolAlias(entry.manifest.name, usedAliases)
          runtimeToolNameByAlias.set(alias, entry.manifest.name)
          return anthropicToolWithCache({
            name: alias,
            description: entry.manifest.description,
            input_schema: entry.manifest.inputSchema as unknown as { type: "object" }
          })
        })
      : []
  const toolDefs: Anthropic.Messages.Tool[] = [submitPlanToolDef, ...runtimeTools].map((tool) => anthropicToolWithCache(tool))

  let parsed: Record<string, unknown> | undefined
  let usage: TokenUsage = { ...ZERO_USAGE }
  let streamedOpsCount = 0
  const maxToolTurns = 6

  if (runtimeTools.length > 0) {
    const loopMessages: Anthropic.MessageParam[] = [
      ...historyMessages,
      { role: "user", content: JSON.stringify(user) }
    ]

    for (let turn = 0; turn < maxToolTurns; turn += 1) {
      const response = await client.messages.create({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        tools: toolDefs,
        tool_choice: { type: "auto" },
        messages: loopMessages
      })
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

      for (const block of response.content) {
        if (block.type === "text" && "text" in block && typeof block.text === "string" && args.onToken) {
          args.onToken(block.text)
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
          parsed = JSON.parse(jsonText) as Record<string, unknown>
          break
        }
        return {
          plan: {
            intent: "needs_clarification",
            summary_for_user: "I need a more specific edit request to produce a valid plan.",
            change_log: [],
            ops: [],
            suggested_next_actions: [
              "Specify the page section to change.",
              "Describe exactly what to update."
            ]
          },
          usage
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
        const result = await executeToolCall({
          runtime: args.toolRuntime!,
          toolName: runtimeToolName,
          input,
          context: {
            siteId: args.toolCallContext?.siteId ?? "default",
            sessionId: args.toolCallContext?.sessionId ?? "dev",
            userId: args.toolCallContext?.userId,
            traceId: args.toolCallContext?.traceId ?? "tool-call",
            plannerProvider: "anthropic"
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
        tools: [submitPlanToolDef],
        tool_choice: { type: "tool", name: "submit_edit_plan" },
        messages: [
          ...historyMessages,
          { role: "user", content: JSON.stringify(user) }
        ],
      })
      for await (const event of stream as AsyncIterable<{
        type?: string
        delta?: { type?: string; partial_json?: string; text?: string }
      }>) {
        if (event.type === "content_block_delta") {
          if (event.delta?.type === "input_json_delta") {
            toolJsonBuf += event.delta.partial_json ?? ""
            if (args.onPlannedOp) {
              const next = extractOpsFromPlanBuffer(toolJsonBuf, streamedOpsCount)
              streamedOpsCount = next.nextEmittedCount
              for (let idx = 0; idx < next.newOps.length; idx += 1) {
                args.onPlannedOp(next.newOps[idx]!, streamedOpsCount - next.newOps.length + idx + 1)
              }
            }
          } else if (event.delta?.type === "text_delta") {
            textBuf += event.delta.text ?? ""
            args.onToken(event.delta.text ?? "")
          }
        }
      }
      const finalMessage = await stream.finalMessage()
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

      // Prefer tool_use input; fall back to text block
      if (toolJsonBuf.length > 0) {
        try {
          parsed = JSON.parse(toolJsonBuf) as Record<string, unknown>
        } catch {
          args.log?.warn({
            event: "anthropic_planner_malformed_tool_json",
            model: args.model,
            toolJsonBufPreview: toolJsonBuf.slice(0, 500),
            toolJsonBufLength: toolJsonBuf.length
          }, "Anthropic planner: malformed JSON from tool stream, falling through to text extraction")
          // Fall through to text extraction
        }
      }
      if (!parsed && textBuf.length > 0) {
        const jsonText = extractJsonObject(textBuf)
        if (jsonText) parsed = JSON.parse(jsonText) as Record<string, unknown>
      }
    } else {
      const response = await client.messages.create({
        model: args.model,
        max_tokens: 8192,
        system: anthropicSystemPromptWithCache(system),
        tools: [submitPlanToolDef],
        tool_choice: { type: "tool", name: "submit_edit_plan" },
        messages: [
          ...historyMessages,
          { role: "user", content: JSON.stringify(user) }
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
        if (jsonText) parsed = JSON.parse(jsonText) as Record<string, unknown>
      }
    }
  } else {
    const response = await client.messages.create({
      model: args.model,
      max_tokens: 8192,
      system: anthropicSystemPromptWithCache(system),
      tools: [submitPlanToolDef],
      tool_choice: { type: "tool", name: "submit_edit_plan" },
      messages: [
        ...historyMessages,
        { role: "user", content: JSON.stringify(user) }
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

    // Extract from tool_use content block
    const toolBlock = response.content.find((b) => b.type === "tool_use")
    if (toolBlock && "input" in toolBlock && toolBlock.input && typeof toolBlock.input === "object") {
      parsed = toolBlock.input as Record<string, unknown>
    } else {
      // Fallback: extract from text block
      const textBlock = response.content.find((b) => b.type === "text")
      const raw = textBlock && "text" in textBlock ? textBlock.text : ""
      const jsonText = extractJsonObject(raw)
      if (jsonText) parsed = JSON.parse(jsonText) as Record<string, unknown>
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

  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      plan: {
        ...planResult.data,
        ops: [planResult.data.ops[0]]
      },
      usage
    }
  }
  return { plan: planResult.data, usage }
}
