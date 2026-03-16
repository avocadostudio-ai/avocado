import type { EditPlan, Operation, PageDoc } from "@ai-site-editor/shared"
import { normalizeRouteCandidate } from "../nlp/intent-helpers.js"
import { orderSlugsHomeFirst } from "../state/session-state.js"
import { imageKeywordsFromQuery } from "../image/image-helpers.js"

export function sentenceCase(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

/**
 * Convert future-tense plan summaries to past tense for post-apply display.
 * Handles "Will verb…" → "Verbed…" and bare imperative "Verb the…" → "Verbed the…"
 */
const IRREGULAR: Record<string, string> = {
  set: "Set", find: "Found", rewrite: "Rewrote", get: "Got",
  put: "Put", cut: "Cut", hit: "Hit", run: "Ran", make: "Made",
  keep: "Kept", build: "Built", send: "Sent", write: "Wrote",
  give: "Gave", take: "Took"
}

function toPastTense(verb: string): string {
  const v = verb.toLowerCase()
  const irregular = IRREGULAR[v]
  if (irregular) return verb[0] === verb[0].toUpperCase() ? irregular : irregular.toLowerCase()
  // silent-e: "replace" → "replaced"
  if (v.endsWith("e")) return verb + "d"
  // consonant-y: "copy" → "copied"
  if (v.endsWith("y") && v.length > 2 && !/[aeiou]/.test(v[v.length - 2])) return verb.slice(0, -1) + "ied"
  // CVC doubling for short verbs: "stop" → "stopped"
  if (v.length <= 4 && /[^aeiou][aeiou][^aeiouwxy]$/.test(v)) return verb + verb[verb.length - 1] + "ed"
  return verb + "ed"
}

const IMPERATIVE_VERBS = [
  "add", "update", "remove", "set", "replace", "create", "move",
  "duplicate", "rename", "delete", "insert", "change", "find",
  "resolve", "generate", "rewrite", "improve"
]
const IMPERATIVE_RE = new RegExp(`^(${IMPERATIVE_VERBS.join("|")})\\b`, "im")

export function futureToPastTense(text: string): string {
  return text
    // Generic "will + any verb" → past tense; capitalize if "Will" was capitalized (sentence start)
    .replace(/\b(W|w)ill\s+([a-z]+)\b/gi, (_m, w: string, verb: string) => {
      const past = toPastTense(verb)
      return w === "W" ? past[0].toUpperCase() + past.slice(1) : past
    })
    // Bare imperative at sentence start (limited to known verbs to avoid false positives)
    .replace(IMPERATIVE_RE, (verb) => toPastTense(verb))
}

export function firstUrlFromText(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"']+/)
  return match ? match[0] : undefined
}

export function preferredImageAltText(args: { query: string; resolvedAlt?: string; existingAlt?: string }) {
  const existingAlt = typeof args.existingAlt === "string" ? args.existingAlt.trim() : ""
  if (existingAlt.length > 0) return existingAlt

  const resolvedAlt = typeof args.resolvedAlt === "string" ? args.resolvedAlt.trim() : ""
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) return resolvedAlt
  if (!resolvedAlt) return sentenceCase(`Photo of ${query}`)

  const queryKeywords = imageKeywordsFromQuery(query, 6)
  if (queryKeywords.length === 0) return resolvedAlt

  const altLower = resolvedAlt.toLowerCase()
  const overlapCount = queryKeywords.filter((keyword) => altLower.includes(keyword.toLowerCase())).length
  // If Unsplash alt does not describe the requested subject well, prefer a query-based alt.
  if (overlapCount === 0) return sentenceCase(`Photo of ${query}`)
  return resolvedAlt
}

// ---------------------------------------------------------------------------
// Slug collection
// ---------------------------------------------------------------------------

export function collectMentionedSlugsFromPlan(plan: EditPlan, fallbackSlug?: string) {
  const seen = new Set<string>()
  const removed = new Set<string>()
  const push = (slug?: string) => {
    if (!slug || typeof slug !== "string") return
    const normalized = normalizeRouteCandidate(slug)
    if (!normalized) return
    seen.add(normalized)
  }

  for (const op of plan.ops) {
    if (op.op === "create_page") {
      push(op.page.slug)
      continue
    }
    if (op.op === "rename_page") {
      push(op.newPageSlug)
      continue
    }
    if (op.op === "remove_page") {
      const normalized = normalizeRouteCandidate(op.pageSlug)
      if (normalized) removed.add(normalized)
      continue
    }
    if (op.op === "move_page") {
      push(op.pageSlug)
      push(op.afterPageSlug)
      continue
    }
    if (op.op === "duplicate_block") {
      if (typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) push(op.toPageSlug)
      else push(op.pageSlug)
      continue
    }
    if (op.op === "duplicate_page") {
      push(op.pageSlug)
      push(op.newPageSlug)
      push(op.afterPageSlug)
      continue
    }
    if (op.op === "update_site_config") continue
    push(op.pageSlug)
  }

  for (const slug of removed) seen.delete(slug)
  if (seen.size === 0) {
    const normalizedFallback = normalizeRouteCandidate(fallbackSlug)
    if (normalizedFallback && !removed.has(normalizedFallback)) seen.add(normalizedFallback)
  }
  return orderSlugsHomeFirst(Array.from(seen))
}

export function collectMentionedSlugsFromOps(ops: Operation[], fallbackSlug?: string) {
  return collectMentionedSlugsFromPlan(
    {
      intent: "edit_plan",
      summary_for_user: "",
      change_log: [],
      ops
    },
    fallbackSlug
  )
}

// ---------------------------------------------------------------------------
// Plan normalization for UI
// ---------------------------------------------------------------------------

export function normalizePlanCopyForUi(plan: EditPlan, currentPage: PageDoc): EditPlan {
  const rewrite = (text: string) =>
    text
      .replace(/\bhome page secondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bsecondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bhero block imageurl\b/gi, "Hero block image")
      .replace(/\bimageurl\b/gi, "Hero block image")
      .replace(/\bimagealt\b/gi, "Hero image alt text")
      // Strip internal block IDs like "b_hero_1772150570555" or "block b_hero_..."
      .replace(/\s*\bon\s+(?:block\s+)?b_[a-z]+_\d+\b/gi, "")
      .replace(/\b(?:block\s+)?b_[a-z]+_\d+\b/gi, "")

  const normalizedSummary = rewrite(plan.summary_for_user)
  const normalizedChangeLog = plan.change_log.map(rewrite)

  if (plan.intent !== "edit_plan" || plan.ops.length !== 1) return plan
  const [op] = plan.ops
  if (op.op !== "update_props") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const block = currentPage.blocks.find((entry) => entry.id === op.blockId)
  if (!block || block.type !== "Hero") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const patch = op.patch as Record<string, unknown>
  const hasSecondaryText = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaText")
  const hasSecondaryHref = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaHref")
  if (!hasSecondaryText && !hasSecondaryHref) return plan

  const nextSummary = "Renamed the Hero secondary CTA."
  const nextChangeLog = ["Updated the Hero secondary CTA text/link."]
  return {
    ...plan,
    summary_for_user: nextSummary,
    change_log: nextChangeLog
  }
}
