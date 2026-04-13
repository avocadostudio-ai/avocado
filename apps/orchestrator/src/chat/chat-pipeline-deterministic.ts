import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"
import { isStandalonePageOperation, normalizeRouteCandidate, parseCreatePageRequest, parseDuplicatePageRequest, requestsContentGeneration } from "../nlp/intent-helpers.js"
import {
  buildCreatePagePlan,
  compileDeterministicPlan,
  quotedText,
  rewriteFromExisting
} from "../nlp/deterministic-planner.js"
import { getPage, getSessionDraft } from "../state/session-state.js"
import { inferTranslationScopeFromMessage } from "./chat-pipeline-translation.js"

export function isRewriteLikeMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrit\w*\b/.test(lower) ||
    /\brephras\w*\b/.test(lower) ||
    /\breword\w*\b/.test(lower) ||
    /\bpolish\w*\b/.test(lower) ||
    /\brefin\w*\b/.test(lower) ||
    /\boptimiz\w*\b/.test(lower) ||
    /\brefresh\w*\b/.test(lower) ||
    /\btighten\w*\b/.test(lower) ||
    /\bclarif\w*\b/.test(lower) ||
    /\bclean\s*up\b/.test(lower) ||
    /\bfreshen\s*up\b/.test(lower) ||
    /\bredo\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bimprove\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bchange\b.*\b(tone|copy|wording|text|messaging)\b/.test(lower) ||
    /\breview\b.*\b(copy|text|wording|content|messaging)\b.*\bfor\b/.test(lower)
  )
}

export function isPerformanceAwareMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\bseo\b/.test(lower) ||
    /\bkeyword/.test(lower) ||
    /\bsemantic/.test(lower) ||
    /\bconversion/.test(lower) ||
    /\baccessibility/.test(lower) ||
    /\breadability/.test(lower) ||
    /\bcta\b/.test(lower) ||
    /\bperformance\b/.test(lower)
  )
}

export function isLikelyTextField(key: string) {
  if (!key) return false
  return !/(^|\.)(?:href|url|image|icon|id)$/i.test(key)
}

export function collectChangedTextFields(ops: Operation[]) {
  const out = new Set<string>()
  for (const op of ops) {
    if (op.op === "update_props") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(key)
      }
      continue
    }

    if (op.op === "update_item") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(`${op.listKey}.${key}`)
      }
    }
  }
  return Array.from(out)
}

export function buildMetaChangeLogEntries(ops: Operation[]): string[] {
  const lines: string[] = []
  for (const op of ops) {
    if (op.op !== "update_page_meta") continue
    const patch = op.patch as Record<string, unknown>
    if (typeof patch.title === "string" && patch.title.length > 0) {
      lines.push(`SEO title \u2192 "${patch.title}"`)
    }
    if (typeof patch.description === "string" && patch.description.length > 0) {
      lines.push(`Meta description \u2192 "${patch.description}"`)
    }
    if (typeof patch.ogImage === "string" && patch.ogImage.length > 0) {
      lines.push(`OG image \u2192 ${patch.ogImage}`)
    }
  }
  return lines
}

const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
const AI_PERFORMANCE_PREFIX = "__ai_performance__:"

export function buildAiInsightChanges(args: { plan: EditPlan; message: string }) {
  if (args.plan.intent !== "edit_plan" || args.plan.ops.length === 0) return []
  if (inferTranslationScopeFromMessage(args.message) !== "none") return []

  const textFields = collectChangedTextFields(args.plan.ops)
  if (textFields.length === 0) return []

  const rewriteLike = isRewriteLikeMessage(args.message)
  const performanceAware = isPerformanceAwareMessage(args.message)

  const lines: string[] = []
  if (rewriteLike) {
    lines.push(`${AI_JUSTIFICATION_PREFIX}This version is more benefit-driven and action-oriented.`)
  }
  if (performanceAware) {
    lines.push(`${AI_PERFORMANCE_PREFIX}This wording improves semantic relevance and supports SEO, accessibility, and conversion checks.`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Deterministic operation change log — factual descriptions of what each op did
// ---------------------------------------------------------------------------

function isImageField(key: string) {
  return /image(Url|Src)?$|^image$|^src$|^url$/i.test(key)
}

function describeUpdatePropsFields(patch: Record<string, unknown>): { hasImage: boolean; textFields: string[] } {
  let hasImage = false
  const textFields: string[] = []
  // Handle nested { props: { ... } } wrapper
  const fields = (typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props))
    ? patch.props as Record<string, unknown>
    : patch
  for (const [key, value] of Object.entries(fields)) {
    if (isImageField(key)) { hasImage = true; continue }
    if (typeof value === "string" && value.trim().length > 0 && isLikelyTextField(key)) {
      textFields.push(key)
    }
  }
  return { hasImage, textFields }
}

/** Format a page slug for display — avoids double-slash for home page "/" */
export function fmtSlug(slug: string): string {
  return slug === "/" ? "/" : `/${slug}`
}

export function buildOpChangeLogEntries(
  ops: Operation[],
  ctx: { getBlockType: (slug: string, blockId: string) => string | undefined }
): string[] {
  const lines: string[] = []
  for (const op of ops) {
    switch (op.op) {
      case "create_page": {
        const title = op.page.title ?? op.page.slug
        lines.push(`Created page "${title}" (${fmtSlug(op.page.slug)})`)
        break
      }
      case "add_block": {
        const bt = op.block.type
        lines.push(`Added ${bt} block to ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "remove_block": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "unknown"
        lines.push(`Removed ${bt} block from ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "move_block": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        lines.push(`Moved ${bt} block on ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "duplicate_block": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        lines.push(`Duplicated ${bt} block on ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "update_props": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        const { hasImage, textFields } = describeUpdatePropsFields(op.patch as Record<string, unknown>)
        if (hasImage && textFields.length > 0) {
          lines.push(`Updated ${bt} image and ${textFields.join(", ")} on ${fmtSlug(op.pageSlug)}`)
        } else if (hasImage) {
          lines.push(`Updated ${bt} image on ${fmtSlug(op.pageSlug)}`)
        } else if (textFields.length > 0) {
          lines.push(`Updated ${bt} ${textFields.join(", ")} on ${fmtSlug(op.pageSlug)}`)
        } else {
          lines.push(`Updated ${bt} on ${fmtSlug(op.pageSlug)}`)
        }
        break
      }
      case "add_item": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        lines.push(`Added item to ${bt} ${op.listKey} on ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "update_item": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        const patch = op.patch as Record<string, unknown>
        const hasImg = Object.keys(patch).some(isImageField)
        if (hasImg) {
          lines.push(`Updated item image in ${bt} ${op.listKey} on ${fmtSlug(op.pageSlug)}`)
        } else {
          lines.push(`Updated item in ${bt} ${op.listKey} on ${fmtSlug(op.pageSlug)}`)
        }
        break
      }
      case "remove_item": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        lines.push(`Removed item from ${bt} ${op.listKey} on ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "move_item": {
        const bt = ctx.getBlockType(op.pageSlug, op.blockId) ?? "block"
        lines.push(`Reordered item in ${bt} ${op.listKey} on ${fmtSlug(op.pageSlug)}`)
        break
      }
      case "rename_page": {
        const label = op.newTitle ? `"${op.newTitle}" (${fmtSlug(op.newPageSlug)})` : fmtSlug(op.newPageSlug)
        lines.push(`Renamed page ${fmtSlug(op.pageSlug)} → ${label}`)
        break
      }
      case "remove_page":
        lines.push(`Removed page ${fmtSlug(op.pageSlug)}`)
        break
      case "duplicate_page": {
        const target = op.newPageSlug ?? "copy"
        lines.push(`Duplicated page ${fmtSlug(op.pageSlug)} → ${fmtSlug(target)}`)
        break
      }
      case "move_page":
        lines.push(`Reordered page ${fmtSlug(op.pageSlug)}`)
        break
      case "update_page_meta":
        // Handled by buildMetaChangeLogEntries — skip to avoid duplication
        break
      case "update_site_config": {
        const patch = op.patch as Record<string, unknown>
        if (typeof patch.name === "string") lines.push(`Site name → "${patch.name}"`)
        if (typeof patch.logo === "string") lines.push(`Site logo updated`)
        if (patch.navLabels) lines.push(`Navigation labels updated`)
        if (patch.navGroups) lines.push(`Navigation groups updated`)
        break
      }
    }
  }
  return lines
}

// ---------------------------------------------------------------------------
// Deterministic create page shortcut
// ---------------------------------------------------------------------------

export function deterministicCreatePagePlan(args: { session: string; message: string; hasPageTemplates?: boolean }) {
  const requestedSlug = parseCreatePageRequest(args.message)
  if (!requestedSlug) return null

  // When the user mentions a template and templates are available, defer to AI planner
  if (/\btemplate\b/i.test(args.message) && args.hasPageTemplates) return null

  // When the user specifies block content (quoted titles, descriptions), defer to AI planner
  if (quotedText(args.message) || /'[^']{2,}'/.test(args.message)) return null

  // When the user asks for content generation beyond simple scaffolding,
  // defer to the AI planner which can produce meaningful content.
  if (requestsContentGeneration(args.message)) return null

  // When the slug is the generic fallback, defer to the LLM so it can derive
  // a meaningful slug from the page name (e.g. "Mountain Climbers" → /mountain-climbers).
  if (requestedSlug === "/new-page") return null

  return buildCreatePagePlan({ session: args.session, requestedSlug, userMessage: args.message })
}

export function deterministicDuplicatePagePlan(args: { session: string; message: string; effectiveSlug: string }) {
  const parsed = parseDuplicatePageRequest(args.message, { currentSlug: args.effectiveSlug })
  if (!parsed?.targetSlug) return null

  const sourceSlug = normalizeRouteCandidate(parsed.sourceSlug ?? args.effectiveSlug)
  const targetSlug = normalizeRouteCandidate(parsed.targetSlug)
  if (!sourceSlug || !targetSlug) return null

  if (sourceSlug === targetSlug) {
    return {
      intent: "needs_clarification",
      summary_for_user: "Source and target page are the same. Provide a different target page path.",
      change_log: [],
      ops: []
    } satisfies EditPlan
  }

  const sourcePage = getPage(args.session, sourceSlug)
  if (!sourcePage) {
    return {
      intent: "needs_clarification",
      summary_for_user: `I couldn't find source page ${sourceSlug}. Select a page to duplicate first.`,
      change_log: [],
      ops: []
    } satisfies EditPlan
  }

  const draft = getSessionDraft(args.session)
  let finalTarget = targetSlug
  if (draft.has(finalTarget)) {
    // Auto-suffix to find an available slug (e.g. /test -> /test-2, /test-3, ...)
    for (let i = 2; i <= 99; i++) {
      const candidate = `${targetSlug}-${i}`
      if (!draft.has(candidate)) { finalTarget = candidate; break }
    }
    if (finalTarget === targetSlug) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Page ${targetSlug} already exists. Choose a different target path.`,
        change_log: [],
        ops: []
      } satisfies EditPlan
    }
  }

  return {
    intent: "edit_plan",
    summary_for_user: `Duplicate ${sourceSlug} into ${finalTarget}.`,
    change_log: [`Duplicate page ${sourceSlug} into ${finalTarget} with all blocks and content.`],
    ops: [{ op: "duplicate_page", pageSlug: sourceSlug, newPageSlug: finalTarget }]
  } satisfies EditPlan
}

export function deterministicSelectedTextRewritePlan(args: {
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}) {
  const sanitizeRewriteToPlainText = (value: string) =>
    value
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, "$1")
      .replace(/[*_`~#>]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim()

  // Disabled: deterministic rewrite is too simplistic (word substitutions / appending "today").
  // Let the AI planner handle rewrite requests so it can generate a proper creative rewrite.
  return null
}

export function shouldReturnDeterministicClarification(message: string) {
  const lower = message.toLowerCase()
  if (/\b(populate|fill)\b/.test(lower)) return false
  return (
    isStandalonePageOperation(message) ||
    /\b(delete|remove)\b.*\b(page|home)\b/.test(lower) ||
    /\b(rename|move)\b.*\bpage\b/.test(lower)
  )
}
