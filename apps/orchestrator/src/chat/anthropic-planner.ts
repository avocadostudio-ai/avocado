import Anthropic from "@anthropic-ai/sdk"
import {
  allowedBlockTypes,
  editPlanSchema,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
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
  repairAndParseJson
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
import { anthropicSystemPromptWithCache, anthropicToolWithCache } from "./anthropic-cache.js"
import { executeToolCall, type ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"

// Minimum text length to treat a text-only model response as meaningful
// content (rather than discarding it in favor of the hardcoded fallback).
const MIN_MEANINGFUL_RESPONSE_LENGTH = 20

/**
 * Try JSON.parse, then repairAndParseJson. Returns parsed object or null.
 */
function tryParseOrRepair(buf: string, log?: { warn: (obj: Record<string, unknown>, msg: string) => void }, model?: string): Record<string, unknown> | null {
  try {
    return JSON.parse(buf) as Record<string, unknown>
  } catch {
    try {
      const result = repairAndParseJson(buf) as Record<string, unknown>
      log?.warn({ event: "anthropic_planner_json_repaired", model: model ?? "unknown" }, "Anthropic planner: repaired malformed tool JSON from stream buffer")
      return result
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
  const system = [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields.",
    'Set complexity to "simple" when the request targets a single block with a straightforward edit (add/remove emoji, change a label, update one field). Set complexity to "standard" for multi-block edits, page creation, translation, content generation, or anything requiring creative judgment.'
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
  manifestBlockTypes?: string[]
  lightweight?: boolean
  signal?: AbortSignal
}): Promise<{ plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta }> {
  const client = args.client ?? (getAnthropicClient() as unknown as PlannerAnthropicClient)
  const effectiveBlockTypes = args.manifestBlockTypes ?? allowedBlockTypes
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

  // Lightweight system prompt for simple prop edits — ~70% fewer instructions
  const system = args.lightweight ? [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    'Emit top-level keys in this exact order: intent (string: "edit_plan"), summary_for_user (string), change_log (array of strings), ops (array of operation objects), suggested_next_actions (array of strings).',
    'Each op object MUST include "op" (e.g. "update_props"), "blockId", and "patch".',
    "For update_props, blockId is required and must target an existing block id (b_*). Set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "Use future tense in summary_for_user and change_log.",
    "For edit_plan: summary_for_user must be ONE short sentence (max ~20 words).",
    "After planning ops, include suggested_next_actions: 2-4 short imperative phrases.",
    selectedBlockId.length > 0
      ? `Selected block is ${selectedBlockId}. Target only this block in ops.`
      : "Respect explicit user target references when present."
  ].join("\n") : [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "Emit top-level keys in this exact order: intent, summary_for_user, change_log, ops, suggested_next_actions. Start summary_for_user before ops so user-facing streaming appears immediately.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "Requests for structured data (schema.org), JSON-LD, microdata, or rich snippets are outside the editor's capabilities — they require code changes. Return intent=needs_clarification explaining this, and suggest using update_page_meta to improve SEO metadata (title, description) instead.",
    "If the user asks a read-only question about page content (e.g. 'list all CTA buttons', 'what images are on this page', 'show me all links and their URLs', 'how many sections are there'), return intent=content_answer with empty ops[]. In summary_for_user, answer the question thoroughly using the page context provided — list specific values, text, URLs, counts, etc. Use markdown tables or bullet lists for clarity. In change_log, include one entry per item found. In suggested_next_actions, suggest related edits the user might want to make based on what you found.",
    "If the user asks for page improvement suggestions, feedback, or what to add next, return intent=needs_clarification with empty ops[]. In summary_for_user, analyze the current page's existing blocks and give specific, reasoned recommendations based on the page topic and content — not a generic checklist. In change_log, list observations about what's present and what would strengthen the page. In suggested_next_actions, provide 2-4 concrete actions.",
    "IMPORTANT: 'review copy for [quality]', 'review text for [trait]', 'improve readability', 'tighten the copy', 'optimize this', 'optimize the copy' are edit requests — generate update_props ops that rewrite the copy to achieve the stated quality goal. Do NOT return needs_clarification for these.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use future tense in summary_for_user and change_log — the plan has not been executed yet. Say 'Update imageUrl to…' or 'Replace the Hero image with…', not 'Updated' or 'Replaced'.",
    "For edit_plan intent: summary_for_user must be ONE short sentence (max ~20 words) confirming what will happen. Do NOT elaborate, explain why, or describe the content being added — let change_log carry the detail. Bad: 'I'll add a RichText section about blueberry varieties right after the FeatureGrid.' Good: 'Adding a **text section** about blueberry varieties after the features grid.'",
    "change_log entries should add specific detail NOT already in summary_for_user — e.g. list the actual content, items, or values being set. Do not paraphrase the summary.",
    "In summary_for_user, use simple markdown for readability: **bold** for key terms or labels, and bullet lists (- item) when listing multiple items, recommendations, or observations. Keep it scannable — avoid walls of text.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page, update_page_meta, update_site_config.",
    "Use update_page_meta to set SEO metadata (title, description, ogImage) on a page. Patch is merge-patch: only supplied keys update. Set a field to empty string to clear it.",
    "Use update_site_config to change the site name, logo URL, or navigation labels. Patch is merge-patch: only supplied keys update. navLabels is a slug→label map (e.g. { \"/pricing\": \"Plans & Pricing\" }).",
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
    "If the user asks to create a page showcasing, demonstrating, or featuring all available components/block types (even with typos like 'componenzs'), generate a create_page op containing one block of each allowed block type. Fill all block props with themed sample content matching the user's topic. This is a clear, actionable request — do not return needs_clarification.",
    "For add_block, use exact prop names from blockContracts. Common mistakes: use 'title' not 'heading' for section titles (except Hero which uses 'heading'), use 'q'/'a' not 'question'/'answer' for FAQ items, use 'quote' not 'testimonial' for Testimonials items.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "For update_props object key order, emit keys exactly as: op, pageSlug (if present), blockId, patch.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If the user explicitly names multiple targets (for example hero CTA and footer CTA), include updates for every named target in the same plan.",
    "When the user gives hard constraints like words/punctuation to avoid, generated copy must strictly honor those constraints.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For rewrite/rephrase requests, if contextPack.selected.block.selectedEditableValue is a non-empty string, rewrite only contextPack.selected.editablePath based on that exact selected text.",
    "If rewrite/rephrase of a specific field is requested but contextPack.selected.editablePath or selected editable text is missing, return intent=needs_clarification and ask the user to select the exact text first. This does NOT apply to page-wide rewrite/refocus/rebrand requests — those should generate update_props ops across all blocks.",
    "When rewriting text, return plain text unless the user explicitly asks for markdown formatting. Do not wrap the entire rewrite in **bold** markers.",
    "For Hero imageUrl, use any placeholder value (the system will resolve the actual image separately). If the user provides an explicit URL, use that URL. Never invent local image paths. Do NOT mention a specific image source (e.g. Unsplash) in summary_for_user — just say 'image'.",
    "For image search requests that explicitly mention Unsplash or stock photos, call tool unsplash.search with a concise search query and choose an imageUrl from tool results.",
    "For image requests that say 'generate', 'create', or 'make' an image, call tool image.generate with a detailed prompt describing the desired image. When calling image.generate, check the target block's image spec in blockContracts for the recommended aspectRatio and pass it. If the user explicitly specifies an aspectRatio, use that instead. Default to quality 'draft'. Use 'final' only when the user explicitly asks for high quality, polished, or production-ready images.",
    "For image requests that mention 'brand', 'our photos', 'company images', 'from Drive', 'from our folder', or 'brand assets', call tool gdrive.browse with an optional search query. Choose an imageUrl from tool results and write it into the relevant imageUrl field.",
    "When using gdrive.browse, write the selected image URL into the relevant imageUrl field and set imageAlt to a concise accessible description.",
    "When using unsplash.search, write the selected image URL into the relevant imageUrl field and set imageAlt to a concise accessible description.",
    "When using image.generate, write the returned imageUrl into the relevant imageUrl field and set imageAlt from the returned alt text.",
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
    ...(pageWideRewrite
      ? [
          "This is a page-wide rewrite/refocus request. Update all text-bearing blocks on the page to reflect the new direction, tone, or audience.",
          "Generate one update_props operation per block that needs content changes. Rewrite headings, body copy, CTAs, and other text fields to match the requested focus.",
          "Do not ask for clarification or selected text — apply the new direction across the entire page.",
        ]
      : []),
    "After planning ops, include suggested_next_actions: 2-4 short imperative phrases the user could type next (max 6 words each). Each suggestion MUST be a logical follow-up to the specific change just made — not a generic action. Ask yourself: 'what would the user likely want to do next given THIS edit?' For example, after rewriting stats labels, suggest refining the same section ('Make the numbers bigger', 'Add a stat about X') — not unrelated actions like 'Change title' or 'Add a Testimonials section'. For needs_clarification, suggest the most likely concrete answers. Omit suggested_next_actions entirely if no contextual follow-up is obvious. Every suggestion must be an action the user can perform inside this editor (editing content, adding/removing sections, changing images, updating SEO metadata). Never suggest actions outside the editor's scope such as A/B testing, analytics, performance monitoring, user research, or marketing strategy.",
    "Never mention internal block IDs (b_hero_*, b_featuregrid_*, etc.), prop names (imageUrl, imageAlt), or system settings in summary_for_user, change_log, or suggested_next_actions. Also avoid raw block type names like 'RichText', 'FeatureGrid', 'CardGrid', 'FAQAccordion' — use natural descriptions instead: 'text section', 'features grid', 'card grid', 'FAQ section'. Exception: 'Hero', 'CTA', and 'Testimonials' are fine as-is since users understand these terms.",
    selectedBlockId.length > 0 && !explicitOtherReference
      ? `Selected block is ${selectedBlockId}. You MUST target only this block in ops unless the user explicitly names a different section.`
      : "Respect explicit user target references when present.",
    `Allowed block types: ${effectiveBlockTypes.join(", ")}.`,
    ...(args.siteContextBlock ? [`\n[site context]\n${args.siteContextBlock}\n[/site context]`] : []),
    ...(args.contextPack.selected?.imageUrlForVision
      ? [
          "An image is attached for the field being edited. Describe its visual content accurately for the alt text. Be specific about what's depicted (objects, people, actions, setting) in 1-2 concise sentences. Do not mention 'AI-generated' or image metadata.",
          `Return an update_props operation setting the "${args.contextPack.selected.editablePath}" field on block "${args.contextPack.selected.blockId}" to your generated alt text description. This is an edit_plan, not needs_clarification.`
        ]
      : [])
  ].join("\n")

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
        forceFullContracts: args.forceFullSchemaContracts
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
  const anthropicFineGrainedStreamHeaders = {
    "anthropic-beta": "fine-grained-tool-streaming-2025-05-14"
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
          headers: anthropicFineGrainedStreamHeaders
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
              parsed = repairAndParseJson(jsonText) as Record<string, unknown>
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
        headers: anthropicFineGrainedStreamHeaders
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
              parsed = repairAndParseJson(jsonText) as Record<string, unknown>
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
              parsed = repairAndParseJson(jsonText) as Record<string, unknown>
            } catch { /* fall through */ }
          }
        }
      }
    }
  } else {
    // No runtime tools — use output_config.format for constrained decoding
    // instead of forcing a tool_use call. This guarantees schema-valid JSON.
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
          parsed = repairAndParseJson(raw) as Record<string, unknown>
          args.log?.warn({ event: "anthropic_planner_json_repaired", model: args.model }, "Anthropic planner: repaired malformed output_config JSON")
        } catch { /* fall through to !parsed check below */ }
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

  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      plan: {
        ...planResult.data,
        ops: [planResult.data.ops[0]]
      },
      usage,
      schemaContext: schemaContext.meta
    }
  }
  return { plan: planResult.data, usage, schemaContext: schemaContext.meta }
}
