import { z } from "zod"
import { allowedBlockTypes, type BlockType, type EditPlan, type EditorComponentsManifest, type PageDoc } from "@ai-site-editor/shared"
import { isLikelyClarificationFollowUp, isStandalonePageOperation } from "./intent-helpers.js"
import { type AIProvider, type ModelKey, versions, pendingClarificationBySession } from "../state/session-state.js"

// ---------------------------------------------------------------------------
// Shared types used by the chat pipeline and intent handlers
// ---------------------------------------------------------------------------

export type GuardrailErrorCategory =
  | "schema_violation"
  | "ambiguity"
  | "not_found"
  | "no_effective_change"
  | "internal_error"

export const siteCapabilitiesSchema = z.object({
  allowStructuralEdits: z.boolean(),
  manifestStatus: z.enum(["loading", "ready", "degraded"]),
  reason: z.string().optional(),
  manifestVersion: z.number().int().positive().optional(),
  componentCount: z.number().int().nonnegative().optional(),
  checkedAt: z.string()
})

export type SiteCapabilities = z.infer<typeof siteCapabilitiesSchema>

export type ChatRequestBody = {
  session?: string
  siteId?: string
  componentsManifest?: EditorComponentsManifest | string
  siteCapabilities?: SiteCapabilities | string
  sitePurpose?: string
  siteHosting?: string
  businessContext?: {
    purpose?: string
    tone?: string
    constraints?: string[]
  } | string
  siteContext?: {
    siteId?: string
    siteName?: string
    purpose?: string
    hosting?: string
    tone?: string
    constraints?: string[]
  } | string
  slug?: string
  message?: string
  modelKey?: ModelKey
  provider?: AIProvider
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  executionMode?: "auto" | "plan_only" | "apply_pending_plan" | "discard_pending_plan"
  pendingPlanId?: string
}

export type ChatResult = {
  status: string
  summary: string
  changes: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  validationErrors?: unknown
  previewVersion: number
  focusBlockId?: string
  updatedSlug?: string
  plannerSource: "openai" | "anthropic" | "demo"
  modelUsed: string
  modelKey: ModelKey
  pendingPlanId?: string
  debug?: {
    traceId: string
    promptHash: string
    promptExcerpt: string
    outcome?: string
    reasonCategory?: GuardrailErrorCategory
    intent?: EditPlan["intent"]
    opTypes?: string[]
    opCount?: number
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    estimatedUsd?: number | null
    skippedOpCount?: number
    skippedOps?: Array<{
      index: number
      op: string
      reason: "empty_patch" | "unchanged_value"
      pageSlug?: string
      blockId?: string
    }>
    timeline?: Array<{
      stage: "request_received" | "first_token" | "first_structured_progress" | "plan_ready" | "first_op_applied" | "done"
      atMs: number
    }>
  }
}

// ---------------------------------------------------------------------------
// Shared normaliser used by all intent detectors below.
// ---------------------------------------------------------------------------

export function normalizeForIntent(message: string) {
  return message.toLowerCase().replace(/\s+/g, " ").trim()
}

// ---------------------------------------------------------------------------
// Single source of truth for block-catalog query patterns.
// ---------------------------------------------------------------------------

// Matches "block(s)", "component(s)", "section(s)", "element(s)", "widget(s)"
const UNIT = String.raw`(?:blocks?|components?|sections?|elements?|widgets?)`
const UNIT_TYPE = String.raw`(?:block|component|section|element|widget)\s+types?`

export const BLOCK_CATALOG_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\bwhat\s+(?:other\s+)?${UNIT}\s+(?:can|do)\s+(?:you|i|we)\s+(?:have|add)\b`),
  new RegExp(String.raw`\bwhich\s+(?:other\s+)?${UNIT}\s+(?:can|do)\s+(?:you|i|we)\s+(?:have|add)\b`),
  new RegExp(String.raw`\bwhat\s+(?:other\s+)?${UNIT_TYPE}\s+(?:can|do)\s+(?:you|i|we)\s+(?:have|add)\b`),
  new RegExp(String.raw`\bwhich\s+(?:other\s+)?${UNIT_TYPE}\s+(?:can|do)\s+(?:you|i|we)\s+(?:have|add)\b`),
  new RegExp(String.raw`\bwhat\s+${UNIT}\s+(?:are|is)\s+(?:available|supported)\b`),
  new RegExp(String.raw`\bwhat\s+${UNIT}\s+are\b.{0,20}\badd\b`),
  new RegExp(String.raw`\bavailabl\w*\s+${UNIT}\b`),
  new RegExp(String.raw`\bavailabl\w*\s+${UNIT_TYPE}\b`),
  /\bwhat\s+else\s+can\s+i\s+add\b/,
  /\bwhat\s+other\s+content\b/,
  /\blist\s+(all\s+)?(the\s+)?(?:blocks?|components?|sections?)\b/
]

export function isBlockCatalogQuery(message: string) {
  const m = normalizeForIntent(message)
  return BLOCK_CATALOG_PATTERNS.some((re) => re.test(m))
}

// ---------------------------------------------------------------------------
// Detects requests to add or update many/all block types at once (e.g.
// "add all available block types", "scaffold the page", "fill out the page",
// "populate all components with sample content").
// When detected the planner should override strict single-op mode.
// ---------------------------------------------------------------------------

const BATCH_ADD_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\badd\s+(?:all|every|each|the\s+remaining|the\s+rest\s+of(?:\s+the)?)\s+${UNIT}\b`),
  new RegExp(String.raw`\badd\s+(?:all|every|each|the\s+remaining|the\s+rest\s+of(?:\s+the)?)\s+${UNIT_TYPE}\b`),
  /\bscaffold\b/,
  /\bfill\s+(?:out\s+)?(?:the\s+)?page\b/,
  /\badd\s+(?:all|every)\s+(?:available|missing|remaining)\b/,
  new RegExp(String.raw`\b(?:all|every)\s+(?:available|missing|remaining)\s+${UNIT}\b`),
  /\bbuild\s+(?:out|up)\s+(?:the\s+)?(?:whole\s+)?page\b/
]

// Detects batch update requests that should also override strict single-op mode.
// e.g. "populate all components", "update all blocks", "fill in all sections"
const BATCH_UPDATE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every|each)\s+${UNIT}\b`),
  new RegExp(String.raw`\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every|each)\s+${UNIT_TYPE}\b`),
  new RegExp(String.raw`\b(?:populate|fill\s+in|fill)\s+(?:all|every|each)\s+(?:the\s+)?${UNIT}\b`),
  /\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every)\s+(?:existing\s+)?(?:content|blocks?|components?|sections?)\b/,
  /\bpopulate\s+(?:the\s+)?(?:whole\s+)?page\b/,
  /\b(?:sample|placeholder|demo)\s+content\s+(?:for|to|in|on)\s+(?:all|every|each)\b/,
  new RegExp(String.raw`\b(?:all|every|each)\s+(?:the\s+)?${UNIT}\s+with\s+(?:sample|placeholder|demo|real)\s+content\b`)
]

const BATCH_PAGE_CREATE_PATTERNS: RegExp[] = [
  /\b(?:create|generate|build|make|draft)\b[^.\n]{0,140}\bpages\b/,
  /\b(?:create|generate|build|make|draft)\b[^.\n]{0,140}\bonly\b[^.\n]{0,140}\bpages\b/,
  /\bpages?\s+for\s+(?:these|those|the following|multiple|several)\b/,
  /\bfor\s+.+\b(?:and|,|&)\b.+\bpages?\b/,
  /\bfor\s+.+\b(?:and|,|&)\b.+\b(?:audiences|users?|customers?|buyers?|founders?|teams?|developers?|marketers?|parents?|students?)\b/
]

const COUNTED_MULTI_BLOCK_ADD_PATTERN =
  /\b(?:add|insert|include|create|generate|build)\s+(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:new\s+)?(?:blocks?|components?|sections?|elements?|widgets?)\b/

const ADD_ACTION_PATTERN = /\b(?:add|insert|include|create|generate|build)\b/

const BLOCK_TYPE_KEYWORDS: Array<{ key: string; pattern: RegExp }> = [
  { key: "hero", pattern: /\bhero\b/ },
  { key: "featuregrid", pattern: /\bfeature\s*grid\b|\bfeatures?\b/ },
  { key: "testimonials", pattern: /\btestimonials?\b|\breviews?\b|\bsocial proof\b/ },
  { key: "faq", pattern: /\bfaq\b/ },
  { key: "cta", pattern: /\bcta\b|\bcall to action\b/ },
  { key: "cardgrid", pattern: /\bcard\s*grid\b|\bcardgrid\b|\bpricing\b/ },
  { key: "card", pattern: /\bcard\b/ },
  { key: "richtext", pattern: /\brich[\s-]?text\b|\btext block\b|\bparagraph\b|\bcopy\b/ },
  { key: "twocolumn", pattern: /\btwo\s*column\b|\btwocolumn\b|\b2\s*column\b/ },
  { key: "stats", pattern: /\bstats?\b|\bstatistics\b|\bmetrics\b|\bnumbers\b/ }
]

const KEYWORD_TO_BLOCK_TYPE: Record<string, BlockType> = {
  hero: "Hero",
  featuregrid: "FeatureGrid",
  testimonials: "Testimonials",
  faq: "FAQAccordion",
  cta: "CTA",
  cardgrid: "CardGrid",
  card: "Card",
  richtext: "RichText",
  twocolumn: "TwoColumn",
  stats: "Stats"
}

function countMentionedBlockTypes(message: string) {
  const matched = new Set<string>()
  for (const entry of BLOCK_TYPE_KEYWORDS) {
    if (entry.pattern.test(message)) matched.add(entry.key)
  }
  return matched.size
}

/** Return the ordered list of BlockType values mentioned in the message. */
export function extractMentionedBlockTypes(message: string): BlockType[] {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  const found: Array<{ key: string; index: number }> = []
  for (const entry of BLOCK_TYPE_KEYWORDS) {
    const match = m.match(entry.pattern)
    if (match && match.index !== undefined) {
      // Avoid double-counting "card" when "cardgrid" already matched at the same position
      if (entry.key === "card" && found.some((f) => f.key === "cardgrid" && Math.abs(f.index - match.index!) <= 4)) continue
      found.push({ key: entry.key, index: match.index })
    }
  }
  // Return in order of appearance in the message
  found.sort((a, b) => a.index - b.index)
  return found.map((f) => KEYWORD_TO_BLOCK_TYPE[f.key]!)
}

export function isBatchAddRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  if (BATCH_ADD_PATTERNS.some((re) => re.test(m)) || BATCH_PAGE_CREATE_PATTERNS.some((re) => re.test(m))) return true
  if (BATCH_UPDATE_PATTERNS.some((re) => re.test(m))) return true
  if (COUNTED_MULTI_BLOCK_ADD_PATTERN.test(m)) return true

  const mentionedBlockTypes = countMentionedBlockTypes(m)
  const hasListSeparator = /,|\band\b|&|\bplus\b/.test(m)
  const refersToBlocks = /\b(?:blocks?|components?|sections?|elements?|widgets?)\b/.test(m)
  return ADD_ACTION_PATTERN.test(m) && mentionedBlockTypes >= 2 && (hasListSeparator || refersToBlocks)
}

/**
 * Detects batch remove requests — any remove/delete/clear that implies
 * multiple blocks should be affected. Broadly matches so the LLM can
 * handle the nuance (typos, "this one", etc.) without strict single-op limits.
 */
export function isBatchRemoveRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  const hasRemoveAction = /\b(?:remove|delete|clear)\b/.test(m)
  if (!hasRemoveAction) return false
  // Any "all/every/everything" + remove → batch
  if (/\b(?:all|every|everything)\b/.test(m)) return true
  // "delete every section", "remove all blocks"
  if (new RegExp(String.raw`\b(?:all|every)\s+${UNIT}\b`).test(m)) return true
  return false
}

export function isInfoQuery(message: string) {
  const m = normalizeForIntent(message)
  return (
    BLOCK_CATALOG_PATTERNS.some((re) => re.test(m)) ||
    /\bwhat\s+can\s+i\s+(change|edit)\b/.test(m) ||
    /\bwhat\s+content\b/.test(m) ||
    /\bcontent\s+elements?\b/.test(m) ||
    /\b(which|what)\s+fields?\b/.test(m) ||
    /\bwhat\s+prop(ertie)?s?\b/.test(m)
  )
}

export function isAdviceQuery(message: string) {
  const m = normalizeForIntent(message)
  return (
    /\b(is it good|is this good|should (we|i)|do you recommend|would you recommend)\b/.test(m) ||
    /\bwhat do you think\b/.test(m) ||
    /\bwhat (can|should) be improved\b/.test(m) ||
    /\bhow can (this|the) page be improved\b/.test(m) ||
    /\bhow (can|should) i improve (this|the) page\b/.test(m) ||
    /\bimprovements?\b/.test(m) ||
    /\bis faq\b/.test(m) ||
    /\bshould .*faq\b/.test(m) ||
    /\bgood idea\b/.test(m)
  )
}

export function adviceResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "anthropic" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args
  const message = (body.message ?? "").toLowerCase()
  const pageLabel = current.slug === "/" ? "this home page" : `this page (${current.slug})`
  const hasFaq = current.blocks.some((block) => block.type === "FAQAccordion")
  const hasHero = current.blocks.some((block) => block.type === "Hero")
  const hasCta = current.blocks.some((block) => block.type === "CTA")

  if (/\bfaq\b/.test(message)) {
    const summary = hasFaq
      ? `Yes, FAQ can work on ${pageLabel}, but keep it concise and near the bottom so it supports decisions without distracting from the main content.`
      : `FAQ is usually a good fit on ${pageLabel} when visitors may have objections (pricing, process, trust, support).`
    const changes = hasFaq
      ? ["Current state: FAQ already exists on this page.", "Recommendation: keep 3-6 high-intent questions."]
      : ["Current state: no FAQ block detected on this page.", "Recommendation: add a compact FAQ section near the bottom."]
    return {
      code: 200,
      payload: {
        status: "advice",
        summary,
        changes,
        suggestions: hasFaq
          ? ["Move FAQ to bottom", "Rewrite FAQ questions for this audience", "Keep FAQ, but reduce to 4 questions"]
          : ["Add FAQ section with 4 questions at the bottom", "Add FAQ below testimonials", "Skip FAQ on this page"],
        mentionedSlugs: [current.slug],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const summary = `It depends on the page goal. For ${pageLabel}, prioritize a clear Hero, supporting proof, and one strong CTA before adding extra sections.`
  const changes = [
    hasHero ? "Hero is present." : "Hero is missing.",
    hasCta ? "CTA is present." : "CTA is missing."
  ]
  return {
    code: 200,
    payload: {
      status: "advice",
      summary,
      changes,
      suggestions: [
        "Add testimonials below Hero",
        "Add FAQ at the bottom",
        "Strengthen the main CTA copy"
      ],
      mentionedSlugs: [current.slug],
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

export function plannerMessageWithPendingContext(session: string, message: string) {
  const pending = pendingClarificationBySession.get(session)
  if (!pending) return message
  if (isStandalonePageOperation(message)) return message
  if (!isLikelyClarificationFollowUp(message)) return message
  return `${pending.baseRequest}\nClarification from user: ${message}`
}

function parseJsonObjectMaybe(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (typeof value === "object") return value as Record<string, unknown>
  return null
}

function normalizeConstraintList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]/g)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

/** Build the site context lines without wrapping in a message. Returns null if empty. */
export function buildSiteContextBlock(args?: {
  sitePurpose?: string
  siteHosting?: string
  businessContext?: ChatRequestBody["businessContext"]
  siteContext?: ChatRequestBody["siteContext"]
  pageDirectory?: string
}): string | null {
  const businessContext = parseJsonObjectMaybe(args?.businessContext)
  const siteContext = parseJsonObjectMaybe(args?.siteContext)
  const purpose =
    (typeof siteContext?.purpose === "string" ? siteContext.purpose.trim() : "") ||
    (typeof businessContext?.purpose === "string" ? businessContext.purpose.trim() : "") ||
    (typeof args?.sitePurpose === "string" ? args.sitePurpose.trim() : "")
  const tone =
    (typeof siteContext?.tone === "string" ? siteContext.tone.trim() : "") ||
    (typeof businessContext?.tone === "string" ? businessContext.tone.trim() : "")
  const constraints = [
    ...normalizeConstraintList(siteContext?.constraints),
    ...normalizeConstraintList(businessContext?.constraints)
  ]
  const siteName = typeof siteContext?.siteName === "string" ? siteContext.siteName.trim() : ""
  const lines = [
    purpose ? `Site purpose: ${purpose}` : null,
    tone ? `Preferred tone: ${tone}` : null,
    constraints.length > 0 ? `Constraints: ${constraints.join("; ")}` : null,
    siteName ? `Site name: ${siteName}` : null,
    args?.pageDirectory ? `Pages:\n${args.pageDirectory}` : null
  ].filter((line): line is string => Boolean(line))

  if (lines.length === 0) return null
  return lines.join("\n")
}

export function withSiteContext(message: string, args?: {
  sitePurpose?: string
  siteHosting?: string
  businessContext?: ChatRequestBody["businessContext"]
  siteContext?: ChatRequestBody["siteContext"]
}) {
  const block = buildSiteContextBlock(args)
  if (!block) return message
  return `${message}\n\n[site context]\n${block}\n[/site context]`
}

export function stripSiteContextEnvelope(message: string) {
  return message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
}

export function extractSiteContextLineValue(message: string, label: string) {
  const lowerLabel = label.toLowerCase()
  const section = message.match(/\[site context\]([\s\S]*?)\[\/site context\]/i)?.[1]
  if (!section) return undefined
  const line = section
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.toLowerCase().startsWith(`${lowerLabel}:`))
  if (!line) return undefined
  const value = line.slice(line.indexOf(":") + 1).trim()
  return value || undefined
}

// ---------------------------------------------------------------------------
// Block prop helpers used by infoResponse
// ---------------------------------------------------------------------------

function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Change heading to \"...\"",
    subheading: "Change subheading to \"...\"",
    ctaText: "Change CTA text to \"...\"",
    ctaHref: "Change CTA link to \"/...\"",
    imageUrl: "Update hero image (e.g. from Unsplash: cherries)",
    imageAlt: "Change image alt text to \"...\"",
    secondaryCtaText: "Add secondary CTA button \"...\"",
    secondaryCtaHref: "Change secondary CTA link to \"/...\"",
    body: "Edit body text to \"...\"",
    title: "Change title to \"...\"",
    description: "Change description to \"...\"",
    features: "Update feature list",
    items: "Update items",
    cards: "Update cards"
  }
  return labels[propKey] ?? `Change ${propKey} to \"...\"`
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]

function humanizeArrayPath(root: string): string {
  const match = root.match(/^([a-zA-Z_]+)\[(\d+)\]$/)
  if (!match) return root
  const [, listName, indexStr] = match
  const index = Number(indexStr)
  const ordinal = ORDINALS[index] ?? `#${index + 1}`
  const singular: Record<string, string> = {
    cards: "card",
    features: "feature",
    items: "item",
    stats: "stat",
    columns: "column"
  }
  const noun = singular[listName] ?? listName.replace(/s$/, "")
  return `the ${ordinal} ${noun}`
}

function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path
  const human = humanizeArrayPath(root)

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${human}'s title to \"...\"`,
      `Update ${human}'s description to \"...\"`,
      `Update ${human}'s CTA text to \"...\"`,
      `Update ${human}'s CTA link to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${human}'s title to \"...\"`, `Update ${human}'s description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${human}'s quote to \"...\"`, `Update ${human}'s author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${human}'s question to \"...\"`, `Update ${human}'s answer to \"...\"`]
  }

  return [`Update ${human} ...`]
}

export function infoResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "anthropic" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args

  if (isBlockCatalogQuery(body.message ?? "")) {
    return {
      code: 200,
      payload: {
        status: "info",
        summary: `You can add these block types: ${allowedBlockTypes.join(", ")}.`,
        changes: ["Tip: specify position, e.g. \u201cadd Testimonials below Hero\u201d."],
        suggestions: [
          "Add Testimonials below Hero",
          "Add CardGrid at the end",
          "Add FeatureGrid after Hero",
          "Add FAQAccordion before CTA",
          "Add CTA at the end"
        ],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const selected =
    body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
      ? current.blocks.find((b) => b.id === body.activeBlockId)
      : null

  if (selected) {
    const keys = editablePropsFromBlock(selected)
    const childPath = String(body.activeEditablePath ?? "")
    const suggestions = childPath ? childSuggestions({ selected, editablePath: childPath }) : keys.slice(0, 4).map(promptFromPropKey)
    const humanChild = childPath ? humanizeArrayPath(childPath.split(".")[0] ?? childPath) : ""
    const summary = childPath
      ? `Focused on ${humanChild} in ${selected.type}.`
      : `You can edit ${selected.type} fields: ${keys.join(", ")}.`
    return {
      code: 200,
      payload: {
        status: "info",
        summary,
        changes: childPath
          ? [`Selected block: ${selected.id}`, `Focused path: ${childPath}`]
          : [`Selected block: ${selected.id}`, "Tip: click a field name in your prompt, e.g. \u201cchange heading to \u2026\u201d."],
        suggestions,
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const firstByType = new Map<BlockType, PageDoc["blocks"][number]>()
  for (const block of current.blocks) {
    if (!firstByType.has(block.type)) firstByType.set(block.type, block)
  }
  const byType = Array.from(firstByType.values()).map((b) => `${b.type}: ${editablePropsFromBlock(b).join(", ")}`)
  return {
    code: 200,
    payload: {
      status: "info",
      summary: "Select a block to get precise editable fields. Current page supports:",
      changes: byType,
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}
