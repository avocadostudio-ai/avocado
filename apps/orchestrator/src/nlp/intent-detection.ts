import { z } from "zod"
import { allowedBlockTypes, getBlockMeta, type BlockType, type EditPlan, type BlockManifest, type PageDoc } from "@avocadostudio-ai/shared"
import { isLikelyClarificationFollowUp, isStandalonePageOperation } from "./intent-helpers.js"
import { type AIProvider, type ModelKey, versions, pendingClarificationBySession } from "../state/session-state.js"
import { type GuardrailErrorCategory } from "../errors.js"
import {
  UNIT,
  BLOCK_CATALOG_PATTERNS,
  BATCH_ADD_PATTERNS,
  BATCH_UPDATE_PATTERNS,
  BATCH_PAGE_CREATE_PATTERNS,
  COUNTED_MULTI_BLOCK_ADD_PATTERN,
  ADD_ACTION_PATTERN,
  BLOCK_TYPE_KEYWORDS,
  KEYWORD_TO_BLOCK_TYPE,
  EACH_BLOCK_TYPE_PATTERN,
  PAGE_WIDE_REWRITE_PATTERNS,
  BATCH_REORDER_PATTERNS,
  PAGE_LIST_PATTERNS,
  CONTENT_QUERY_PATTERNS,
  FIELD_CONTENT_UPDATE_PATTERN
} from "./intent-patterns.js"

// Re-export for backward compatibility
export type { GuardrailErrorCategory }

export const siteCapabilitiesSchema = z.object({
  allowStructuralEdits: z.boolean(),
  manifestStatus: z.enum(["loading", "ready", "degraded"]),
  reason: z.string().optional(),
  manifestVersion: z.number().int().positive().optional(),
  blockCount: z.number().int().nonnegative().optional(),
  checkedAt: z.string()
})

export type SiteCapabilities = z.infer<typeof siteCapabilitiesSchema>

const businessContextObjectSchema = z.object({
  purpose: z.string().optional(),
  tone: z.string().optional(),
  constraints: z.array(z.string()).optional(),
})

const siteContextObjectSchema = z.object({
  siteId: z.string().optional(),
  siteName: z.string().optional(),
  purpose: z.string().optional(),
  hosting: z.string().optional(),
  tone: z.string().optional(),
  constraints: z.array(z.string()).optional(),
  gdriveFolderId: z.string().optional(),
})

export const chatRequestBodySchema = z.object({
  session: z.string().optional(),
  siteId: z.string().optional(),
  componentsManifest: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  siteCapabilities: z.union([siteCapabilitiesSchema, z.string()]).optional(),
  sitePurpose: z.string().optional(),
  siteHosting: z.string().optional(),
  businessContext: z.union([businessContextObjectSchema, z.string()]).optional(),
  siteContext: z.union([siteContextObjectSchema, z.string()]).optional(),
  locale: z.string().optional(),
  slug: z.string().optional(),
  message: z.string().optional(),
  modelKey: z.enum(["fast", "balanced", "reasoning", "codex"]).optional(),
  provider: z.enum(["openai", "anthropic", "gemini"]).optional(),
  activeBlockId: z.string().optional(),
  activeBlockType: z.string().optional(),
  activeEditablePath: z.string().optional(),
  executionMode: z.enum(["auto", "plan_only", "apply_pending_plan", "discard_pending_plan", "continue_chain"]).optional(),
  pendingPlanId: z.string().optional(),
  continuationChainId: z.string().optional(),
})

export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>

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
  undoSlug?: string
  plannerSource: "openai" | "anthropic" | "gemini" | "demo"
  modelUsed: string
  modelKey: ModelKey
  pendingPlanId?: string
  /**
   * Tier-1 destructive-action reasons, surfaced when the approval gate was
   * triggered because the plan contains destructive ops (remove_page with
   * content, multi-page scope, bulk deletes). Rendered as a warning in the
   * approval card so the user sees what will be deleted before confirming.
   */
  destructiveReasons?: string[]
  continuation?: {
    chainId: string
    currentStep: number
    totalSteps: number
    nextStepLabel: string
  }
  debug?: {
    traceId: string
    promptHash: string
    promptExcerpt: string
    outcome?: string
    reasonCategory?: GuardrailErrorCategory
    reason?: string
    intent?: EditPlan["intent"]
    opTypes?: string[]
    opCount?: number
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    estimatedUsd?: number | null
    plannerTier?: "forced_deterministic" | "deterministic" | "llm_intent_router" | "full_llm" | "demo"
    modelUsed?: string
    plannerSource?: "openai" | "anthropic" | "gemini" | "demo"
    planningAttempts?: number
    executionMode?: string
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
    currentPage?: string
    siteId?: string
    activeBlockId?: string
    activeEditablePath?: string
    /**
     * Auto-routing decision. Populated when the chat pipeline considered an
     * automatic model-tier change (up- or downgrade). `reason: "shadow"` means
     * the upgrade was logged but not applied — used while validating the
     * router's complexity signal before flipping `CHAT_AUTO_UPGRADE_COMPLEX`.
     */
    routingDecision?: {
      from: "fast" | "balanced" | "reasoning" | "codex"
      to: "fast" | "balanced" | "reasoning" | "codex"
      reason: "simple_downgrade" | "complex_upgrade" | "shadow" | "user_override"
      complexity?: "simple" | "standard" | "complex"
    }
  }
}

// ---------------------------------------------------------------------------
// Shared normaliser used by all intent detectors below.
// ---------------------------------------------------------------------------

export function normalizeForIntent(message: string) {
  return message.toLowerCase().replace(/\s+/g, " ").trim()
}

// Backward-compatible re-exports — patterns now live in intent-patterns.ts
export { BLOCK_CATALOG_PATTERNS } from "./intent-patterns.js"

export function isBlockCatalogQuery(message: string) {
  const m = normalizeForIntent(message)
  return BLOCK_CATALOG_PATTERNS.some((re) => re.test(m))
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

/**
 * Returns true when the message is "add X in/to [the Y] heading/subheading/copy/..."
 * — a field-content update phrased with "add", NOT a batch block add.
 * Guards the loose fallback below from false positives when field-targeting
 * prepositions are combined with block-type keyword aliases like "numbers"
 * (Stats) or "copy" (RichText).
 */
export function isFieldContentUpdateRequest(message: string) {
  return FIELD_CONTENT_UPDATE_PATTERN.test(stripSiteContextEnvelope(message))
}

export function isBatchAddRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  if (BATCH_ADD_PATTERNS.some((re) => re.test(m)) || BATCH_PAGE_CREATE_PATTERNS.some((re) => re.test(m))) return true
  if (BATCH_UPDATE_PATTERNS.some((re) => re.test(m))) return true
  if (COUNTED_MULTI_BLOCK_ADD_PATTERN.test(m)) return true
  if (EACH_BLOCK_TYPE_PATTERN.test(m)) return true

  // "add X in/to Y heading/subheading/copy/..." is a field update, not a batch add.
  // The loose fallback below would otherwise fire on messages where block-type
  // keywords like "numbers" (Stats) or "copy" (RichText) happen to appear.
  if (isFieldContentUpdateRequest(message)) return false

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
export function isPageWideRewriteRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  return PAGE_WIDE_REWRITE_PATTERNS.some((re) => re.test(m))
}

export function isBatchReorderRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  return BATCH_REORDER_PATTERNS.some((re) => re.test(m))
}

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

/**
 * Detects duplicate/copy/clone requests targeting a block on the current
 * page. The fast LLM intent router's schema has no "duplicate" action
 * (only add|move|update|remove|info|clarify), so these requests must
 * bypass the router and go straight to the full planner, which supports
 * the `duplicate_block` op.
 */
export function isDuplicateBlockRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  // "duplicate X", "clone X", "copy X", "make a copy of X" — where X is any
  // block reference. Guard against "copy" matching unrelated phrases like
  // "the copy" (RichText body) by requiring a verb-y context.
  if (/\b(?:duplicate|clone)\b/.test(m)) return true
  if (/\bmake\s+(?:a|another)\s+copy\b/.test(m)) return true
  // "copy the <block>", "copy this block" — verb use
  if (/\bcopy\s+(?:this|that|the|a|an|another)\s+/.test(m)) return true
  return false
}

/**
 * Detects "duplicate this page and modify the content" patterns — duplicate /
 * clone / copy a page combined with a modification verb (populate, fill,
 * suggest, update, modify, change, adjust, replace, rewrite). Used to bypass
 * `chatStrictPrimaryOpMode` so the planner can emit `duplicate_page` plus
 * follow-on `update_props` / `add_block` / `remove_block` ops in one plan.
 *
 * Without this, strict mode truncates duplicate-and-modify plans to just the
 * `duplicate_page` op, leaving the user with an unmodified clone.
 */
export function isDuplicateAndModifyRequest(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  // Must mention a duplicate verb in a page context (not a block-level dup).
  const duplicateVerb = /\b(?:duplicate|clone|copy)\b/.test(m)
  if (!duplicateVerb) return false
  // Page context: explicit "page", "this", "current", "selected", or a route mention.
  const pageContext = /\b(?:page|this|current|selected)\b/.test(m) || /\/[a-z0-9/_-]+/i.test(m)
  if (!pageContext) return false
  // Modification verbs that imply additional ops beyond the bare duplicate.
  const modifyVerb =
    /\b(?:populate|fill|suggest|propose|recommend|generate|write|draft|describe)\b/.test(m) ||
    /\b(?:modify|adjust|tweak|customi[sz]e|tailor|adapt|repurpose|reskin|rebrand|refresh|refocus)\b/.test(m) ||
    /\b(?:update|change|replace|rewrite|swap|edit|repopulate)\b/.test(m) ||
    /\b(?:and\s+(?:then\s+)?)?(?:make|turn|convert|transform)\s+it\s+(?:into|about|for)\b/.test(m)
  return modifyVerb
}

/**
 * Detects "show me a plan first" / "plan it before doing" phrasing — the user
 * wants the planner to assemble ops but hold them behind the approval gate
 * instead of auto-applying. Used by the chat pipeline to override
 * `executionMode` to `plan_only` when the message asks for review-before-apply.
 */
export function requestsPlanFirst(message: string) {
  const m = normalizeForIntent(stripSiteContextEnvelope(message))
  // "make a plan first", "plan it first", "draft a plan", "show me a plan",
  // "propose a plan", "plan before applying", "plan before doing", "plan it before"
  if (/\b(?:make|draft|propose|prepare|create|show)\s+(?:me\s+)?(?:a|the)?\s*plan\b/.test(m)) return true
  if (/\bplan\s+(?:it|this|first|before)\b/.test(m)) return true
  if (/\bbefore\s+(?:doing|applying|making|executing|building)\b.*\bplan\b/.test(m)) return true
  if (/\bplan\b.*\bbefore\s+(?:doing|applying|making|executing|building)\b/.test(m)) return true
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
    /\bwhat\s+prop(ertie)?s?\b/.test(m) ||
    /\b(?:what|which)\s+(?:tabs?|items?|cards?|features?|links?|images?|pages?|columns?)\s+(?:do|does|can|are)\s+(?:we|i|you|it|this)\s+have\b/.test(m)
  )
}

export function isPageListQuery(message: string) {
  const m = normalizeForIntent(message)
  // Exclude messages that contain page creation/modification verbs — those are action
  // requests that happen to mention "the pages", not listing queries.
  if (/\b(?:add|create|generate|build|make|draft|update|link|remove|delete)\b.*\bpages?\b/.test(m)) return false
  return PAGE_LIST_PATTERNS.some((re) => re.test(m))
}

export function isContentQuery(message: string) {
  const m = normalizeForIntent(message)
  // Exclude messages with clear edit/mutation verbs
  if (/\b(?:add|create|remove|delete|update|change|replace|move|rewrite|translate|rename)\b/.test(m)) return false
  return CONTENT_QUERY_PATTERNS.some((re) => re.test(m))
}

export function isAdviceQuery(message: string) {
  const m = normalizeForIntent(message)
  // Exclude structural action requests that happen to contain "should we/I"
  if (/\b(reorder|reorganize|restructure|rearrange|sort|move)\b/.test(m) && /\bpages?\b/.test(m)) return false
  // Exclude explicit edit verbs — "review copy for clarity" is an edit, not advice
  // But allow "should we/I add X?" phrasing — those are advice, not commands
  if (!/\bshould\s+(we|i)\b/.test(m) && /\b(?:add|create|remove|delete|update|change|replace|move|rewrite|translate|rename)\b/.test(m)) return false
  return (
    /\b(is it good|is this good|should (we|i)|do you recommend|would you recommend)\b/.test(m) ||
    /\bwhat do you think\b/.test(m) ||
    /\bwhat (can|should) be improved\b/.test(m) ||
    /\bhow can (this|the) page be improved\b/.test(m) ||
    /\bhow (can|should) i improve (this|the) page\b/.test(m) ||
    /\bimprovements?\b/.test(m) ||
    /\bis faq\b/.test(m) ||
    /\bshould .*faq\b/.test(m) ||
    /\bgood idea\b/.test(m) ||
    /\b(?:audit|review|check|inspect|analyze)\s+(?:the\s+)?(?:this\s+)?(?:page|site|content|copy|text)\b/.test(m)
  )
}

export function adviceResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "anthropic" | "gemini" | "demo"
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

  // Analyze existing blocks on the page
  const existingTypes = new Set(current.blocks.map((b) => b.type))
  const presentList = current.blocks.map((b) => {
    const meta = getBlockMeta(b.type)
    return meta ? `${meta.displayName}` : b.type
  })
  const missingTypes = allowedBlockTypes.filter((t) => !existingTypes.has(t))

  const changes: string[] = []
  changes.push(`Current blocks (${current.blocks.length}): ${presentList.join(", ") || "none"}.`)
  if (!hasHero) changes.push("Missing: Hero — consider adding a headline section at the top.")
  if (!hasCta) changes.push("Missing: CTA — add a call-to-action to drive conversions.")
  if (!existingTypes.has("Testimonials") && !existingTypes.has("Stats"))
    changes.push("Missing: social proof (Testimonials or Stats) — builds trust.")
  if (!existingTypes.has("FAQAccordion"))
    changes.push("Missing: FAQ — addresses objections and improves SEO.")

  // Build contextual suggestions based on what's actually missing
  const suggestions: string[] = []
  const suggestionPriority: Array<{ type: string; label: string }> = [
    { type: "Hero", label: "Add a Hero section at the top" },
    { type: "CTA", label: "Add a CTA section to drive conversions" },
    { type: "Testimonials", label: "Add Testimonials for social proof" },
    { type: "Stats", label: "Add Stats to highlight key numbers" },
    { type: "FAQAccordion", label: "Add FAQ at the bottom" },
    { type: "FeatureGrid", label: "Add a Feature Grid to list benefits" },
    { type: "CardGrid", label: "Add a Card Grid for related content" },
    { type: "ContactForm", label: "Add a Contact Form" },
    { type: "Footer", label: "Add a Footer with links" }
  ]
  for (const item of suggestionPriority) {
    if (!existingTypes.has(item.type) && suggestions.length < 4) suggestions.push(item.label)
  }
  // If page has all common blocks, suggest content improvements based on actual props
  if (suggestions.length === 0) {
    for (const block of current.blocks) {
      if (suggestions.length >= 4) break
      const p = block.props as Record<string, unknown> | undefined
      if (!p) continue
      if (block.type === "Hero") {
        const heading = (p.heading ?? p.title ?? "") as string
        if (!p.imageUrl && !p.backgroundImage) {
          suggestions.push("Add a hero image")
        } else if (heading && heading.length > 60) {
          suggestions.push("Shorten the hero headline to under 60 characters")
        } else if (heading) {
          suggestions.push("Rewrite the hero headline to be more action-oriented")
        }
      }
      if (block.type === "Stats") {
        const items = (p.items ?? p.stats) as Array<Record<string, unknown>> | undefined
        if (items?.some((it) => ((it.label ?? it.description ?? "") as string).length > 30)) {
          suggestions.push("Rewrite the stats labels to be shorter and number-driven")
        }
      }
      if (block.type === "CTA") {
        const btn = (p.buttonText ?? p.ctaText ?? "") as string
        if (btn.length > 20) {
          suggestions.push("Shorten the CTA button text")
        } else {
          suggestions.push("Strengthen the CTA copy to create urgency")
        }
      }
    }
    // Fallback if no content-specific suggestions were derived
    if (suggestions.length === 0) {
      if (hasHero) suggestions.push("Rewrite the hero headline")
      if (hasCta) suggestions.push("Strengthen the CTA copy")
      suggestions.push("Tighten the copy across all sections")
    }
  }

  const summary = `For ${pageLabel} with ${current.blocks.length} block${current.blocks.length === 1 ? "" : "s"}: ${missingTypes.length > 0 ? `consider adding ${missingTypes.slice(0, 3).join(", ")}` : "all major sections are covered — focus on refining content"}.`

  return {
    code: 200,
    payload: {
      status: "advice",
      summary,
      changes,
      suggestions,
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
  const pageTemplates = Array.isArray(siteContext?.pageTemplates)
    ? (siteContext.pageTemplates as Array<{ name?: unknown; description?: unknown }>)
        .filter((t) => typeof t?.name === "string" && typeof t?.description === "string" && (t.name as string).trim() && (t.description as string).trim())
        .map((t) => `- ${(t.name as string).trim()}: ${(t.description as string).trim()}`)
    : []
  const lines = [
    purpose ? `Site purpose: ${purpose}` : null,
    tone ? `Preferred tone: ${tone}` : null,
    constraints.length > 0 ? `Constraints: ${constraints.join("; ")}` : null,
    siteName ? `Site name: ${siteName}` : null,
    pageTemplates.length > 0 ? `Page templates:\n${pageTemplates.join("\n")}` : null,
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
  plannerSource: "openai" | "anthropic" | "gemini" | "demo"
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
