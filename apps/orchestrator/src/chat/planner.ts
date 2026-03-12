import OpenAI from "openai"
import { z } from "zod"
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
  inferBlockTypeFromText,
  normalizeOpName,
  normalizePlanCandidate
} from "../nlp/plan-normalizer.js"
import { type TokenUsage, extractUsage, ZERO_USAGE } from "../telemetry/usage.js"
import { editPlanJsonSchema } from "./plan-json-schema.js"
import type { ToolRuntime } from "../tools/runtime.js"
import type { ToolExecutionEvent } from "../tools/types.js"

export type PlannerFailureReasonCategory = "schema_violation" | "planner_refusal" | "incomplete_output" | "malformed_output" | "internal_error"

export class PlannerOutputError extends Error {
  reasonCategory: PlannerFailureReasonCategory
  retryable: boolean

  constructor(message: string, options: { reasonCategory: PlannerFailureReasonCategory; retryable?: boolean }) {
    super(message)
    this.name = "PlannerOutputError"
    this.reasonCategory = options.reasonCategory
    this.retryable = options.retryable ?? false
  }
}

export function isPlannerOutputError(error: unknown): error is PlannerOutputError {
  return error instanceof PlannerOutputError
}

const rawPlanCandidateSchema = z.object({
  intent: z.enum(["edit_plan", "needs_clarification"]).optional(),
  summary_for_user: z.string().optional(),
  change_log: z.array(z.string()).optional(),
  ops: z.array(z.record(z.unknown())).optional(),
  suggested_next_actions: z.array(z.string()).optional()
}).passthrough()

function asObject(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function toPlannerError(category: PlannerFailureReasonCategory, message: string, retryable = false) {
  return new PlannerOutputError(message, { reasonCategory: category, retryable })
}

function extractCompletionRefusal(completion: unknown): string | null {
  const choices = asObject(completion)?.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = asObject(choices[0])
  const message = asObject(choice?.message)
  const refusal = message?.refusal
  return typeof refusal === "string" && refusal.trim().length > 0 ? refusal.trim() : null
}

function extractResponsesOutcome(response: unknown): { refusal: string | null; incomplete: boolean } {
  const directRefusal = asObject(response)?.refusal
  if (typeof directRefusal === "string" && directRefusal.trim().length > 0) {
    return { refusal: directRefusal.trim(), incomplete: false }
  }
  const status = asObject(response)?.status
  if (status === "incomplete") return { refusal: null, incomplete: true }
  const output = asObject(response)?.output
  if (Array.isArray(output)) {
    for (const item of output) {
      const refusal = asObject(item)?.refusal
      if (typeof refusal === "string" && refusal.trim().length > 0) return { refusal: refusal.trim(), incomplete: false }
      const itemStatus = asObject(item)?.status
      if (itemStatus === "incomplete") return { refusal: null, incomplete: true }
    }
  }
  return { refusal: null, incomplete: false }
}

export function isChatStrictPrimaryOpMode() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_STRICT_PRIMARY_OP_MODE ?? "").trim())
}

export function isPageWideTranslationRequest(message: string) {
  const lower = message.toLowerCase()
  const asksTranslation =
    /\btranslate\b/.test(lower) ||
    /\btranslation\b/.test(lower) ||
    /\blocaliz/.test(lower) ||
    /\bgerman\b/.test(lower) ||
    /\bdeutsch\b/.test(lower)
  if (!asksTranslation) return false
  return (
    /\b(this|the|entire|whole|full)\s+(\w+\s+)*page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+(\w+\s+)*page\b/.test(lower)
  )
}

export type PlannerContractMode = "minimal" | "targeted" | "full"

export type PlannerSchemaContextMeta = {
  contractMode: PlannerContractMode
  contractBytes: number
  contractBlockCount: number
  targetBlockTypes: string[]
  strictJsonEnabled: boolean
}

type PlannerSchemaContextPayload = {
  blockContracts?: ReturnType<typeof blockContractsSummary>
  pageMetaContract?: ReturnType<typeof pageMetaContractSummary>
  knownBlockTypes?: string[]
  editPlanShape?: {
    intent: string
    summary_for_user: string
    change_log: string[]
    ops: string[]
    suggested_next_actions: string[]
  }
}

const EDIT_PLAN_SHAPE_HINT = {
  intent: "edit_plan | needs_clarification",
  summary_for_user: "string",
  change_log: ["string"],
  ops: ["Operation[]"],
  suggested_next_actions: ["string (optional, 2-4 items)"]
}

export function isStrictJsonResponseEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_STRICT_JSON_RESPONSE ?? "").trim())
}

export function isAdaptiveSchemaContextEnabled() {
  return /^(1|true|yes|on)$/i.test((process.env.CHAT_ADAPTIVE_SCHEMA_CONTEXT ?? "").trim())
}

function schemaBudgetBytes() {
  const parsed = Number(process.env.CHAT_SCHEMA_BUDGET_BYTES ?? "9000")
  if (!Number.isFinite(parsed) || parsed <= 0) return 9000
  return Math.max(512, Math.trunc(parsed))
}

function bytesForPayload(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function uniqueBlockTypes(values: unknown[]) {
  const known = new Set(allowedBlockTypes.map((type) => type.toLowerCase()))
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue
    const normalized = value.toLowerCase()
    if (!known.has(normalized) || seen.has(normalized)) continue
    seen.add(normalized)
    const canonical = allowedBlockTypes.find((type) => type.toLowerCase() === normalized)
    if (canonical) out.push(canonical)
  }
  return out
}

function pickTargetBlockTypes(args: {
  message: string
  contextPack: ReturnType<typeof plannerContextPack>
}) {
  const selectedType = typeof args.contextPack.selected.blockType === "string" ? args.contextPack.selected.blockType : null
  const inferredFromMessage = inferBlockTypeFromText(args.message)
  const referencedTypes = [
    args.contextPack.resolvedReferences.target?.type,
    args.contextPack.resolvedReferences.anchor?.type,
    ...args.contextPack.resolvedReferences.mentionedBlocks.map((item) => item.type)
  ]
  return uniqueBlockTypes([selectedType, inferredFromMessage, ...referencedTypes])
}

function shouldUseMinimalContracts(message: string) {
  const lower = message.toLowerCase()
  if (/\b(seo|meta|metadata|og\s*image|open\s*graph)\b/.test(lower)) return false
  if (/\b(translate|translation|localiz)\b/.test(lower)) return false
  if (/\b(create|add|insert|build|generate|update|change|edit|rewrite|rephrase)\b/.test(lower)) return false
  return (
    /\b(remove|delete|move|reorder|rename)\b/.test(lower) ||
    /\b(remove|delete|move|reorder|rename)\b.*\bpage\b/.test(lower)
  )
}

function shouldUseFullContracts(args: {
  message: string
  batchOverride: boolean
  pageWideTranslation: boolean
  forceFullContracts: boolean
  targetBlockTypes: string[]
}) {
  if (args.forceFullContracts) return true
  if (args.pageWideTranslation || args.batchOverride) return true
  const lower = args.message.toLowerCase()
  const structuralGeneration =
    /\b(create|add|insert|build|generate)\b/.test(lower) &&
    !/\b(page|meta|seo)\b/.test(lower) &&
    args.targetBlockTypes.length === 0
  if (structuralGeneration) return true
  return false
}

function buildContractsForMode(args: {
  mode: PlannerContractMode
  targetBlockTypes: string[]
  includePageMetaContract: boolean
}): PlannerSchemaContextPayload {
  const allContracts = blockContractsSummary()
  const payload: PlannerSchemaContextPayload = {
    knownBlockTypes: Object.keys(blockSchemas),
    editPlanShape: EDIT_PLAN_SHAPE_HINT
  }

  if (args.mode === "full") {
    payload.blockContracts = allContracts
  } else if (args.mode === "targeted") {
    const filtered: Record<string, ReturnType<typeof blockContractsSummary>[string]> = {}
    for (const type of args.targetBlockTypes) {
      if (type in allContracts) filtered[type] = allContracts[type]!
    }
    if (Object.keys(filtered).length > 0) payload.blockContracts = filtered
  }

  if (args.includePageMetaContract) payload.pageMetaContract = pageMetaContractSummary()
  return payload
}

export function buildPlannerSchemaContext(args: {
  message: string
  contextPack: ReturnType<typeof plannerContextPack>
  batchOverride: boolean
  pageWideTranslation: boolean
  legacyIncludeContracts: boolean
  forceFullContracts?: boolean
}): { payload: PlannerSchemaContextPayload; meta: PlannerSchemaContextMeta } {
  const strictJsonEnabled = isStrictJsonResponseEnabled()
  const targetBlockTypes = pickTargetBlockTypes({ message: args.message, contextPack: args.contextPack })
  const includePageMetaContract = /\b(seo|meta|metadata|og\s*image|open\s*graph)\b/i.test(args.message)

  if (!isAdaptiveSchemaContextEnabled()) {
    const payload: PlannerSchemaContextPayload = args.legacyIncludeContracts
      ? {
          blockContracts: blockContractsSummary(),
          pageMetaContract: pageMetaContractSummary(),
          knownBlockTypes: Object.keys(blockSchemas),
          editPlanShape: EDIT_PLAN_SHAPE_HINT
        }
      : {}
    const contractBlockCount = payload.blockContracts ? Object.keys(payload.blockContracts).length : 0
    return {
      payload,
      meta: {
        contractMode: args.legacyIncludeContracts ? "full" : "minimal",
        contractBytes: bytesForPayload(payload),
        contractBlockCount,
        targetBlockTypes,
        strictJsonEnabled
      }
    }
  }

  const forceFullContracts = args.forceFullContracts === true
  const preferredMode: PlannerContractMode = shouldUseFullContracts({
    message: args.message,
    batchOverride: args.batchOverride,
    pageWideTranslation: args.pageWideTranslation,
    forceFullContracts,
    targetBlockTypes
  })
    ? "full"
    : shouldUseMinimalContracts(args.message)
      ? "minimal"
      : "targeted"
  const fallbackOrder: PlannerContractMode[] =
    preferredMode === "full"
      ? ["full", "targeted", "minimal"]
      : preferredMode === "targeted"
        ? ["targeted", "minimal"]
        : ["minimal"]

  const budget = schemaBudgetBytes()
  let selectedMode = fallbackOrder[0]!
  let selectedPayload = buildContractsForMode({
    mode: selectedMode,
    targetBlockTypes,
    includePageMetaContract
  })
  let selectedBytes = bytesForPayload(selectedPayload)

  for (const mode of fallbackOrder) {
    const payload = buildContractsForMode({ mode, targetBlockTypes, includePageMetaContract })
    const bytes = bytesForPayload(payload)
    selectedMode = mode
    selectedPayload = payload
    selectedBytes = bytes
    if (bytes <= budget) break
  }

  const contractBlockCount = selectedPayload.blockContracts ? Object.keys(selectedPayload.blockContracts).length : 0
  return {
    payload: selectedPayload,
    meta: {
      contractMode: selectedMode,
      contractBytes: selectedBytes,
      contractBlockCount,
      targetBlockTypes,
      strictJsonEnabled
    }
  }
}

export type PlannerOpenAIClient = {
  chat: {
    completions: {
      create: (args: unknown) => any
    }
  }
  responses: {
    create: (args: unknown) => any
  }
}

export function openAIChatOptionsForModel(model: string) {
  // o-series and gpt-5 family reject temperature in chat.completions; omit to use model default.
  const lower = model.toLowerCase()
  if (lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || lower.startsWith("gpt-5")) return {}
  return { temperature: 0 as const }
}

export function isResponsesOnlyModel(_model: string) {
  // No current OpenAI model requires the Responses API exclusively; all supported models
  // use chat.completions. Update this if a future model mandates the Responses API.
  return false
}

export function extractResponsesOutputText(response: unknown) {
  const direct = (response as { output_text?: unknown } | null)?.output_text
  if (typeof direct === "string" && direct.length > 0) return direct

  const output = (response as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return ""

  const chunks: string[] = []
  for (const item of output as Array<{ content?: unknown }>) {
    if (!item || typeof item !== "object") continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content as Array<{ text?: unknown; type?: unknown }>) {
      if (!part || typeof part !== "object") continue
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text)
    }
  }
  return chunks.join("")
}

export function extractOpsFromPlanBuffer(raw: string, emittedCount: number) {
  const opsKeyIdx = raw.indexOf('"ops"')
  if (opsKeyIdx < 0) return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }
  const arrStart = raw.indexOf("[", opsKeyIdx)
  if (arrStart < 0) return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }

  const extracted: Operation[] = []
  let inString = false
  let escape = false
  let arrDepth = 0
  let objDepth = 0
  let objStart = -1

  for (let i = arrStart; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === "\\") {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "[") {
      arrDepth += 1
      continue
    }
    if (ch === "]") {
      if (arrDepth > 0) arrDepth -= 1
      if (arrDepth === 0) break
      continue
    }
    if (arrDepth !== 1) continue
    if (ch === "{") {
      if (objDepth === 0) objStart = i
      objDepth += 1
      continue
    }
    if (ch === "}") {
      if (objDepth > 0) objDepth -= 1
      if (objDepth === 0 && objStart >= 0) {
        const json = raw.slice(objStart, i + 1)
        try {
          const parsed = JSON.parse(json) as Operation
          extracted.push(parsed)
        } catch {
          // Ignore partial/invalid object fragments while streaming.
        }
        objStart = -1
      }
    }
  }

  if (extracted.length <= emittedCount) {
    return { nextEmittedCount: emittedCount, newOps: [] as Operation[] }
  }
  return {
    nextEmittedCount: extracted.length,
    newOps: extracted.slice(emittedCount)
  }
}

export async function parseIntentWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
  client?: PlannerOpenAIClient
}): Promise<ParsedIntent> {
  const client = args.client ?? (new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as unknown as PlannerOpenAIClient)
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

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Intent parser did not return JSON")
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

export async function generatePlanWithOpenAI(args: {
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
  client?: PlannerOpenAIClient
  siteContextBlock?: string | null
  forceFullSchemaContracts?: boolean
}): Promise<{ plan: EditPlan; usage: TokenUsage; schemaContext: PlannerSchemaContextMeta }> {
  const client = args.client ?? (new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as unknown as PlannerOpenAIClient)
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
    "If the user asks for page improvement suggestions, feedback, or what to add next, return intent=needs_clarification with empty ops[]. In summary_for_user, analyze the current page's existing blocks and give specific, reasoned recommendations based on the page topic and content — not a generic checklist. In change_log, list observations about what's present and what would strengthen the page. In suggested_next_actions, provide 2-4 concrete actions.",
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
    "For add_block, use exact prop names from blockContracts. Common mistakes: use 'title' not 'heading' for section titles (except Hero which uses 'heading'), use 'q'/'a' not 'question'/'answer' for FAQ items, use 'quote' not 'testimonial' for Testimonials items.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For rewrite/rephrase requests, if contextPack.selected.block.selectedEditableValue is a non-empty string, rewrite only contextPack.selected.editablePath based on that exact selected text.",
    "If rewrite/rephrase is requested but contextPack.selected.editablePath or selected editable text is missing, return intent=needs_clarification and ask the user to select the exact text first.",
    "When rewriting text, return plain text unless the user explicitly asks for markdown formatting. Do not wrap the entire rewrite in **bold** markers.",
    "For Hero imageUrl, use any placeholder value (the system will resolve the actual image separately). If the user provides an explicit URL, use that URL. Never invent local image paths. Do NOT mention a specific image source (e.g. Unsplash) in summary_for_user — just say 'image'.",
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
  const schemaContext = buildPlannerSchemaContext({
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
  const strictJson = schemaContext.meta.strictJsonEnabled

  let raw = ""
  let usage: TokenUsage = { ...ZERO_USAGE }
  let streamedOpsCount = 0
  if (isResponsesOnlyModel(args.model)) {
    const response = await client.responses.create({
      model: args.model,
      instructions: system,
      input: JSON.stringify(user)
    })
    const responsesOutcome = extractResponsesOutcome(response)
    if (responsesOutcome.refusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${responsesOutcome.refusal}`)
    }
    if (responsesOutcome.incomplete) {
      throw toPlannerError("incomplete_output", "Model returned incomplete planning output")
    }
    raw = extractResponsesOutputText(response)
    usage = extractUsage(response)
    if (args.onToken && raw.length > 0) args.onToken(raw)
  } else if (args.onToken) {
    const stream = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      stream: true,
      response_format: {
        type: "json_schema" as const,
        json_schema: { name: "EditPlan", schema: editPlanJsonSchema, strict: strictJson }
      },
      messages: [
        { role: "system", content: system },
        ...(args.history ?? []),
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    let sawRefusal = false
    for await (const chunk of stream) {
      const deltaRefusal = (chunk as { choices?: Array<{ delta?: { refusal?: unknown } }> })?.choices?.[0]?.delta?.refusal
      if (typeof deltaRefusal === "string" && deltaRefusal.trim().length > 0) {
        sawRefusal = true
        raw += deltaRefusal
        continue
      }
      const delta = chunk.choices[0]?.delta?.content
      if (typeof delta !== "string" || delta.length === 0) continue
      raw += delta
      args.onToken(delta)
      if (args.onPlannedOp) {
        const next = extractOpsFromPlanBuffer(raw, streamedOpsCount)
        streamedOpsCount = next.nextEmittedCount
        for (let idx = 0; idx < next.newOps.length; idx += 1) {
          args.onPlannedOp(next.newOps[idx]!, streamedOpsCount - next.newOps.length + idx + 1)
        }
      }
    }
    if (sawRefusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${raw.slice(0, 300)}`)
    }
    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
    // Streaming doesn't return per-chunk usage; leave as zero
  } else {
    const completion = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      response_format: {
        type: "json_schema" as const,
        json_schema: { name: "EditPlan", schema: editPlanJsonSchema, strict: strictJson }
      },
      messages: [
        { role: "system", content: system },
        ...(args.history ?? []),
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    const refusal = extractCompletionRefusal(completion)
    if (refusal) {
      throw toPlannerError("planner_refusal", `Model refused planning output: ${refusal}`)
    }
    raw = completion.choices[0]?.message?.content ?? ""
    if (raw.trim().length === 0) {
      throw toPlannerError("incomplete_output", "Model returned no planning output")
    }
    usage = extractUsage(completion)
  }
  const jsonText = extractJsonObject(raw)
  if (!jsonText) {
    throw toPlannerError("malformed_output", "Model did not return JSON", true)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(jsonText)
  } catch {
    throw toPlannerError("malformed_output", "Model returned malformed JSON", true)
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
