import { allowedBlockTypes, type BlockType, type EditPlan, type PageDoc } from "@ai-site-editor/shared"
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

export type ChatRequestBody = {
  session?: string
  siteId?: string
  sitePurpose?: string
  siteHosting?: string
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
    estimatedUsd?: number | null
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

export const BLOCK_CATALOG_PATTERNS: RegExp[] = [
  /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
  /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
  /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
  /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
  /\bwhat\s+else\s+can\s+i\s+add\b/,
  /\bwhat\s+other\s+content\b/,
  /\bavailable\s+blocks?\b/,
  /\bavailable\s+block\s+types?\b/
]

export function isBlockCatalogQuery(message: string) {
  const m = normalizeForIntent(message)
  return BLOCK_CATALOG_PATTERNS.some((re) => re.test(m))
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

export function withSiteContext(message: string, sitePurpose?: string, siteHosting?: string) {
  const purpose = typeof sitePurpose === "string" ? sitePurpose.trim() : ""
  const hosting = typeof siteHosting === "string" ? siteHosting.trim() : ""
  if (!purpose && !hosting) return message
  const lines: string[] = []
  if (purpose) lines.push(`Site purpose: ${purpose}`)
  if (hosting) lines.push(`Hosting context: ${hosting}`)
  return `${message}\n\n[site context]\n${lines.join("\n")}\n[/site context]`
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

function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${root}.title to \"...\"`,
      `Update ${root}.description to \"...\"`,
      `Update ${root}.ctaText to \"...\"`,
      `Update ${root}.ctaHref to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${root}.title to \"...\"`, `Update ${root}.description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${root}.quote to \"...\"`, `Update ${root}.author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${root}.q to \"...\"`, `Update ${root}.a to \"...\"`]
  }

  return [`Update ${root} ...`]
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
    const summary = childPath
      ? `Focused ${selected.type} item: ${childPath}.`
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
