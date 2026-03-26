import { isStandalonePageOperation, requestsContentGeneration } from "../nlp/intent-helpers.js"
import { inferDeterministicIntent, plannerContextPack } from "../nlp/deterministic-planner.js"
import type { EditPlan, PageDoc } from "@ai-site-editor/shared"
import { inferTranslationScopeFromMessage, type TranslationScope } from "./chat-pipeline-translation.js"
import { isRewriteLikeMessage } from "./chat-pipeline-deterministic.js"
import { isRewriteRequest } from "../nlp/deterministic-planner-patches.js"

function isClarificationFollowUp(message: string) {
  return message.includes("\nClarification from user:")
}

export function shouldPreferFastModelForMessage(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  if (isClarificationFollowUp(message)) return false
  // Compound multi-field requests (2+ quoted values) need full context, not lightweight mode
  if (isCompoundMultiFieldRequest(message)) return false
  if (isRewriteLikeMessage(message)) return true
  // Simple targeted prop edits — single-block text/label/emoji modifications
  // don't need the balanced model. Fast is sufficient.
  const lower = message.toLowerCase()
  if (isSingleBlockPropEdit(lower)) return true
  return false
}

/** Detects compound multi-field requests with 2+ quoted values, e.g.
 * "set subheading to 'X' and change CTA text to 'Y'" */
function isCompoundMultiFieldRequest(message: string) {
  const quoteChars = message.match(/['''"""\u201C\u201D\u2018\u2019]/g)
  return !!(quoteChars && quoteChars.length >= 4)
}

function isSingleBlockPropEdit(lower: string) {
  // Action verb + small cosmetic target (emojis, icons, labels, text, links)
  const cosmeticTarget = /\b(emojis?|icons?|labels?|names?|titles?|text|headings?|links?)\b/
  if (!cosmeticTarget.test(lower)) return false
  // Must have a simple action verb — not create/build/generate (which imply complex content)
  return /\b(add|remove|strip|delete|drop|clear|change|update|put|set|replace)\b/.test(lower)
}

export function shouldUseLlmIntentRouter(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  if (isClarificationFollowUp(message)) return false
  const normalized = message.trim()
  if (normalized.length === 0 || normalized.length > 260) return false
  return (
    isRewriteLikeMessage(normalized) ||
    /\b(replace|change|update|set|edit|remove|delete|move|reorder|add)\b/.test(normalized.toLowerCase())
  )
}

export function compactPlannerContextPack(args: {
  contextPack: ReturnType<typeof plannerContextPack>
  message: string
  translationScope: TranslationScope
}) {
  if (args.translationScope === "page") return args.contextPack
  const lower = args.message.toLowerCase()
  const keepsFullContext =
    /\b(create|generate|build|duplicate)\b.*\bpage\b/.test(lower) ||
    /\b(rename|remove|delete|move)\b.*\bpage\b/.test(lower) ||
    /\btranslate\b/.test(lower)
  if (keepsFullContext) return args.contextPack

  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const compactOutline = args.contextPack.pageOutline.map((entry) => {
    if (entry.id === selectedBlockId) return entry
    return {
      id: entry.id,
      type: entry.type,
      props: {},
      arrayProps: entry.arrayProps
    }
  })

  return {
    ...args.contextPack,
    pageOutline: compactOutline,
    recentSuccessfulEdits: args.contextPack.recentSuccessfulEdits.slice(-3)
  }
}

export function minimalPlannerContextPack(args: {
  contextPack: ReturnType<typeof plannerContextPack>
}) {
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  if (!selectedBlockId) return args.contextPack

  const neighborIds = new Set(
    [args.contextPack.neighbors.previous?.id, args.contextPack.neighbors.next?.id]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  )

  const compactOutline = args.contextPack.pageOutline
    .filter((entry) => entry.id === selectedBlockId || neighborIds.has(entry.id))
    .map((entry) => {
      if (entry.id === selectedBlockId) return entry
      return {
        id: entry.id,
        type: entry.type,
        props: {},
        arrayProps: entry.arrayProps
      }
    })

  const routeSet = new Set<string>()
  routeSet.add(args.contextPack.route)
  for (const slug of args.contextPack.pageRoutes) {
    if (routeSet.size >= 6) break
    routeSet.add(slug)
  }

  return {
    ...args.contextPack,
    pageRoutes: Array.from(routeSet),
    pageOutline: compactOutline,
    recentSuccessfulEdits: args.contextPack.recentSuccessfulEdits.slice(-1),
    // Keep resolvedReferences from full context — small (~50 tokens) but helps LLM
    // target the right block even in minimal mode
    resolvedReferences: args.contextPack.resolvedReferences
  }
}

export function shouldUseMinimalPlannerContext(args: {
  message: string
  translationScope: TranslationScope
  activeBlockId?: string
  activeEditablePath?: string
}) {
  if (args.translationScope !== "none") return false
  if (!args.activeBlockId && !args.activeEditablePath) return false
  if (isStandalonePageOperation(args.message)) return false
  const lower = args.message.toLowerCase()
  return (
    isRewriteLikeMessage(lower) ||
    isSingleBlockPropEdit(lower) ||
    /\b(replace|change|update|set|edit|rewrite|rephrase)\b/.test(lower)
  )
}

export function shouldPreferFocusedTranslation(args: {
  message: string
  inferredScope: TranslationScope
  activeBlockId?: string
}) {
  if (args.inferredScope !== "page") return false
  if (!args.activeBlockId) return false
  const lower = args.message.toLowerCase()
  const hasExplicitPageCue =
    /\b(this|the|entire|whole|full)\s+page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+page\b/.test(lower)
  if (hasExplicitPageCue) return false
  return true
}

/**
 * Uses the deterministic planner's intent analysis to classify message
 * complexity, providing more accurate context packing decisions than
 * the pure-regex heuristics in shouldPreferFastModelForMessage.
 *
 * Returns "simple" when the intent is fully resolvable from the message
 * (add/remove/move with clear target, or update with extracted patch).
 * Returns "standard" otherwise.
 */
export function classifyMessageComplexity(args: {
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
  translationScope: TranslationScope
}): "simple" | "standard" {
  if (args.translationScope !== "none") return "standard"
  if (isStandalonePageOperation(args.message)) return "standard"

  // Rewrites need surrounding context for tone matching even when intent is clear
  if (isRewriteRequest(args.message)) return "standard"

  const intent = inferDeterministicIntent({
    message: args.message,
    currentPage: args.currentPage,
    activeBlockId: args.activeBlockId,
    activeEditablePath: args.activeEditablePath
  })

  if (!intent?.action) return "standard"

  // Structural ops (add/remove/move) with a resolved target are simple
  if (intent.action === "add" || intent.action === "remove" || intent.action === "move") {
    if (intent.target_block_type || intent.new_block_type || intent.target_block_ref) {
      return "simple"
    }
  }

  // Update with an extracted patch means the value was fully parsed from the message
  if (intent.action === "update" && intent.patch && Object.keys(intent.patch).length > 0) {
    return "simple"
  }

  // Update with a resolved target block but no patch — needs LLM for content
  return "standard"
}

/**
 * Checks whether a router plan is too shallow for the message's intent.
 *
 * Returns true when the message signals content generation need (e.g.,
 * "add a compelling hero about our mission") but the router plan only
 * has default/placeholder props. In this case the full planner should
 * be preferred.
 */
export function isRouterPlanTooShallow(message: string, plan: EditPlan): boolean {
  if (plan.intent !== "edit_plan" || plan.ops.length === 0) return false

  // Check if message requests meaningful content
  const wantsContent = requestsContentGeneration(message) ||
    /\b(about|featuring|directing|promoting|highlighting|compelling|engaging)\b/i.test(message)
  if (!wantsContent) return false

  // Check if the plan only has add_block ops with default-looking props
  for (const op of plan.ops) {
    if (op.op !== "add_block") continue
    const block = (op as { block?: { props?: Record<string, unknown> } }).block
    if (!block?.props) continue

    const values = Object.values(block.props)
    const stringValues = values.filter((v): v is string => typeof v === "string")
    // If all string props are short defaults (< 30 chars), the plan is shallow
    const allShort = stringValues.length > 0 && stringValues.every(v => v.length < 30)
    if (allShort) return true
  }

  return false
}
