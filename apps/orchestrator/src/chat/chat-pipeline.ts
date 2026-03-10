import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import {
  editorComponentsManifestSchema,
  getAllBlockMeta,
  type BlockType,
  type EditPlan,
  type EditorComponentsManifest,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import type { UnsplashImage } from "../variation-images.js"
import { isStandalonePageOperation, normalizeRouteCandidate, parseCreatePageRequest, parseDuplicatePageRequest, requestsContentGeneration } from "../nlp/intent-helpers.js"
import {
  type ChatRequestBody,
  type ChatResult,
  siteCapabilitiesSchema,
  isBlockCatalogQuery,
  isInfoQuery,
  isAdviceQuery,
  adviceResponse,
  plannerMessageWithPendingContext,
  buildSiteContextBlock,
  infoResponse
} from "../nlp/intent-detection.js"
import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import {
  type AIProvider,
  type ModelKey,
  type PendingImageGeneration,
  versions,
  pendingClarificationBySession,
  chatHistoryBySession,
  pendingApprovalPlanBySession,
  orderSlugsHomeFirst,
  getSessionDraft,
  getPage,
  setPage,
  pushUndo,
  bumpVersion,
  pushRecentEdit,
  pushChatHistory,
  schedulePersistState
} from "../state/session-state.js"
import {
  toErrorDetail,
  isNoEffectiveChangeError,
  classifyGuardrailError,
  formatValidationError,
  isDeterministicRepairEligible,
  buildDeterministicRepairFeedback,
  type SkippedOperation,
  applyOpsAtomically,
  isStructuralOperation,
  pickFocusBlockId,
  pickUpdatedSlug
} from "../ops/ops-engine.js"
import {
  buildCreatePagePlan,
  clarificationSuggestions,
  postEditSuggestions,
  demoPlanFromMessage,
  plannerContextPack,
  compileDeterministicPlan,
  inferDeterministicIntent,
  isHighConfidenceDeterministicCase,
  quotedText,
  rewriteFromExisting
} from "../nlp/deterministic-planner.js"
import { generatePlanWithOpenAI, parseIntentWithOpenAI } from "./planner.js"
import { generatePlanWithAnthropic, parseIntentWithAnthropic } from "./anthropic-planner.js"
import { type TokenUsage, estimateUsd } from "../telemetry/usage.js"
import {
  heroImageQueryFromContext,
  imageKeywordsFromQuery,
  generateVariationImageWithOpenAI,
  resolveUnsplashImage,
  isExplicitImageGenRequest,
  extractImagePromptFromMessage
} from "../image/image-helpers.js"

let generatePlanWithOpenAIImpl = generatePlanWithOpenAI
export function setGeneratePlanWithOpenAIForTests(fn?: typeof generatePlanWithOpenAI) {
  generatePlanWithOpenAIImpl = fn ?? generatePlanWithOpenAI
}

let generatePlanWithAnthropicImpl = generatePlanWithAnthropic
export function setGeneratePlanWithAnthropicForTests(fn?: typeof generatePlanWithAnthropic) {
  generatePlanWithAnthropicImpl = fn ?? generatePlanWithAnthropic
}

let demoPlanFromMessageImpl = demoPlanFromMessage
export function setDemoPlanFromMessageForTests(fn?: typeof demoPlanFromMessage) {
  demoPlanFromMessageImpl = fn ?? demoPlanFromMessage
}

let parseIntentWithOpenAIImpl = parseIntentWithOpenAI
export function setParseIntentWithOpenAIForTests(fn?: typeof parseIntentWithOpenAI) {
  parseIntentWithOpenAIImpl = fn ?? parseIntentWithOpenAI
}

let parseIntentWithAnthropicImpl = parseIntentWithAnthropic
export function setParseIntentWithAnthropicForTests(fn?: typeof parseIntentWithAnthropic) {
  parseIntentWithAnthropicImpl = fn ?? parseIntentWithAnthropic
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type ChatPipelineContext = {
  log: FastifyBaseLogger
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function firstUrlFromText(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"']+/)
  return match ? match[0] : undefined
}

function sentenceCase(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}

function shouldPreferFastModelForMessage(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  return isRewriteLikeMessage(message)
}

function shouldUseLlmIntentRouter(message: string) {
  if (inferTranslationScopeFromMessage(message) !== "none") return false
  if (isStandalonePageOperation(message)) return false
  const normalized = message.trim()
  if (normalized.length === 0 || normalized.length > 260) return false
  return (
    isRewriteLikeMessage(normalized) ||
    /\b(replace|change|update|set|edit|remove|delete|move|reorder|add)\b/.test(normalized.toLowerCase())
  )
}

function compactPlannerContextPack(args: {
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

function minimalPlannerContextPack(args: {
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
    resolvedReferences: {
      target: null,
      anchor: null,
      mentionedBlocks: []
    }
  }
}

function shouldUseMinimalPlannerContext(args: {
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
    /\b(replace|change|update|set|edit|rewrite|rephrase)\b/.test(lower)
  )
}

function shouldPreferFocusedTranslation(args: {
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

function blockHasImageUrlProp(
  block: PageDoc["blocks"][number] | null | undefined
): block is PageDoc["blocks"][number] {
  if (!block) return false
  const props = block.props as Record<string, unknown>
  return typeof props === "object" && props !== null && Object.prototype.hasOwnProperty.call(props, "imageUrl")
}

function parsePath(path: string): Array<string | number> {
  const parts: Array<string | number> = []
  for (const match of path.matchAll(/([^[.\]]+)|\[(\d+)\]/g)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  return parts
}

function getValueAtPath(root: unknown, path: string): unknown {
  if (!path) return root
  let current: unknown = root
  for (const part of parsePath(path)) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setValueAtPath(root: Record<string, unknown>, path: string, value: unknown) {
  const parts = parsePath(path)
  if (parts.length === 0) return
  let current: unknown = root
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const part = parts[idx]
    const next = parts[idx + 1]
    if (typeof part === "number") {
      if (!Array.isArray(current)) return
      if (current[part] === undefined || current[part] === null) {
        current[part] = typeof next === "number" ? [] : {}
      }
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return
    const holder = current as Record<string, unknown>
    if (!(part in holder) || holder[part] === undefined || holder[part] === null) {
      holder[part] = typeof next === "number" ? [] : {}
    }
    current = holder[part]
  }
  const leaf = parts[parts.length - 1]
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) return
    current[leaf] = value
    return
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return
  ;(current as Record<string, unknown>)[leaf] = value
}

function deleteValueAtPath(root: Record<string, unknown>, path: string) {
  const parts = parsePath(path)
  if (parts.length === 0) return
  let current: unknown = root
  for (let idx = 0; idx < parts.length - 1; idx += 1) {
    const part = parts[idx]
    if (typeof part === "number") {
      if (!Array.isArray(current)) return
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return
    current = (current as Record<string, unknown>)[part]
  }
  const leaf = parts[parts.length - 1]
  if (typeof leaf === "number") {
    if (!Array.isArray(current)) return
    delete current[leaf]
    return
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) return
  delete (current as Record<string, unknown>)[leaf]
}

function extractIndexedQueries(message: string) {
  const out = new Map<number, string>()
  for (const m of message.matchAll(/\b(?:card|item|feature|tile)\s*(\d+)\s*[:=]\s*"([^"]+)"/gi)) {
    const idx = Number(m[1]) - 1
    const value = m[2]?.trim()
    if (Number.isFinite(idx) && idx >= 0 && value) out.set(idx, value)
  }
  return out
}

function extractReferencedItemIndices(message: string) {
  const numeric = new Set<number>()
  let includesLast = false

  for (const m of message.matchAll(/\b(?:card|item|feature|tile)\s*(\d+)(?:st|nd|rd|th)?\b/gi)) {
    const idx = Number(m[1]) - 1
    if (Number.isFinite(idx) && idx >= 0) numeric.add(idx)
  }
  for (const m of message.matchAll(/\b(\d+)(?:st|nd|rd|th)\s+(?:card|item|feature|tile)\b/gi)) {
    const idx = Number(m[1]) - 1
    if (Number.isFinite(idx) && idx >= 0) numeric.add(idx)
  }
  for (const m of message.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)\s+(?:card|item|feature|tile)\b/gi)) {
    const value = String(m[1] ?? "").toLowerCase()
    if (value === "last") {
      includesLast = true
      continue
    }
    const idx =
      value === "first" ? 0 :
      value === "second" ? 1 :
      value === "third" ? 2 :
      value === "fourth" ? 3 :
      value === "fifth" ? 4 :
      value === "sixth" ? 5 :
      value === "seventh" ? 6 :
      value === "eighth" ? 7 :
      value === "ninth" ? 8 :
      value === "tenth" ? 9 :
      -1
    if (idx >= 0) numeric.add(idx)
  }

  return { numeric, includesLast, hasConstraint: numeric.size > 0 || includesLast }
}

function detectImagePaths(value: unknown, basePath = "", acc = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => detectImagePaths(entry, `${basePath}[${idx}]`, acc))
    return acc
  }
  if (!value || typeof value !== "object") return acc
  const obj = value as Record<string, unknown>
  for (const [key, child] of Object.entries(obj)) {
    const nextPath = basePath ? `${basePath}.${key}` : key
    if (key === "imageUrl") acc.add(nextPath)
    detectImagePaths(child, nextPath, acc)
  }
  return acc
}

function imageQueryFromItem(item: Record<string, unknown>) {
  const candidate = [
    item.imageAlt,
    item.title,
    item.heading,
    item.name,
    item.description,
    item.subheading,
    item.quote,
    item.label,
    item.q
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
  const terms = imageKeywordsFromQuery(candidate, 4)
  return terms.length > 0 ? terms.join(" ") : ""
}

function shouldPopulateAllChildImages(message: string) {
  const lower = message.toLowerCase()
  return /\b(images?|photos?|pictures?)\b/.test(lower) && /\b(all|each|every)\b/.test(lower) && /\b(cards?|items?|features?|tiles?|children)\b/.test(lower)
}

function findImageTargets(args: {
  message: string
  currentPage: PageDoc
  targetBlock: PageDoc["blocks"][number]
  patchCandidate: Record<string, unknown>
}) {
  const mergedProps = {
    ...((args.targetBlock.props as Record<string, unknown>) ?? {}),
    ...args.patchCandidate
  }
  const explicitByIndex = extractIndexedQueries(args.message)
  const constrainedIndices = extractReferencedItemIndices(args.message)
  const defaultQuery = heroImageQueryFromContext({
    message: args.message,
    currentPage: args.currentPage,
    targetBlock: args.targetBlock,
    patchCandidate: args.patchCandidate
  })

  const imagePaths = detectImagePaths(mergedProps)
  if (shouldPopulateAllChildImages(args.message)) {
    for (const [key, value] of Object.entries(mergedProps)) {
      if (!Array.isArray(value)) continue
      value.forEach((entry, idx) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return
        imagePaths.add(`${key}[${idx}].imageUrl`)
      })
    }
  }

  const targets: Array<{ path: string; altPath: string; query: string }> = []
  for (const path of imagePaths) {
    const itemMatch = path.match(/^(.*\[(\d+)\])\.imageUrl$/)
    const index = itemMatch?.[2] ? Number(itemMatch[2]) : undefined
    const itemPath = itemMatch?.[1]
    if (constrainedIndices.hasConstraint && itemPath && index !== undefined) {
      let allowed = constrainedIndices.numeric.has(index)
      if (!allowed && constrainedIndices.includesLast) {
        const listPath = itemPath.replace(/\[\d+\]$/, "")
        const listValue = getValueAtPath(mergedProps, listPath)
        if (Array.isArray(listValue) && index === listValue.length - 1) allowed = true
      }
      if (!allowed) continue
    }
    const indexed = index !== undefined ? explicitByIndex.get(index) : undefined
    let query = indexed ?? ""
    if (!query && itemPath) {
      const item = getValueAtPath(mergedProps, itemPath)
      if (item && typeof item === "object" && !Array.isArray(item)) query = imageQueryFromItem(item as Record<string, unknown>)
    }
    if (!query) query = defaultQuery
    targets.push({ path, altPath: path.replace(/imageUrl$/, "imageAlt"), query })
  }
  return targets
}

function rewriteAddBlockToChildImageUpdate(args: { plan: EditPlan; message: string; currentPage: PageDoc; slug: string }): EditPlan {
  if (args.plan.intent !== "edit_plan") return args.plan
  const lower = args.message.toLowerCase()
  const referencesContainerChildren =
    /\b(in|inside|within)\b/.test(lower) ||
    /\b(?:to|for)\s+(?:all|each|every)\s+\w+/.test(lower) ||
    /\b(?:all|each|every)\s+\w+/.test(lower)
  const shouldRewrite =
    /\b(images?|photos?|pictures?)\b/.test(lower) &&
    /\b(all|each|every)\b/.test(lower) &&
    referencesContainerChildren &&
    !/\b(new|another)\b/.test(lower)
  if (!shouldRewrite) return args.plan

  const rewrittenOps: Operation[] = []
  let changed = false
  const hasObjectArrayProp = (block: PageDoc["blocks"][number]) =>
    Object.values((block.props ?? {}) as Record<string, unknown>).some((value) =>
      Array.isArray(value) && value.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    )
  for (const op of args.plan.ops) {
    if (op.op !== "add_block") {
      rewrittenOps.push(op)
      continue
    }
    let existing =
      op.block.type === "Card"
        ? args.currentPage.blocks.find((block) => block.type === "CardGrid") ??
          args.currentPage.blocks.find((block) => block.type === "Card")
        : args.currentPage.blocks.find((block) => block.type === op.block.type)
    if (!existing || !hasObjectArrayProp(existing)) {
      existing =
        args.currentPage.blocks.find((block) => hasObjectArrayProp(block)) ??
        existing
    }
    if (!existing) {
      rewrittenOps.push(op)
      continue
    }
    const existingProps = (existing.props ?? {}) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(existingProps)) {
      if (!Array.isArray(value)) continue
      const nextItems = value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
        const item = entry as Record<string, unknown>
        const titleLike =
          typeof item.title === "string" ? item.title :
          typeof item.heading === "string" ? item.heading :
          typeof item.name === "string" ? item.name :
          "Card image"
        return {
          ...item,
          imageUrl: typeof item.imageUrl === "string" && item.imageUrl.trim().length > 0 ? item.imageUrl : "pending",
          imageAlt: typeof item.imageAlt === "string" && item.imageAlt.trim().length > 0 ? item.imageAlt : `Image for ${titleLike}`
        }
      })
      patch[key] = nextItems
    }
    if (Object.keys(patch).length === 0) {
      rewrittenOps.push(op)
      continue
    }
    rewrittenOps.push({
      op: "update_props",
      pageSlug: args.slug,
      blockId: existing.id,
      patch
    })
    changed = true
  }

  if (!changed) return args.plan
  return {
    ...args.plan,
    summary_for_user: "Will update images in the existing section.",
    change_log: ["Will update child images in the existing component instead of adding a duplicate section."],
    ops: rewrittenOps
  }
}

export type TranslationScope = "page" | "component" | "none"

export function sanitizeMessageForPlanning(message: string) {
  const normalized = message.replace(/\r\n?/g, "\n").trim()
  if (normalized.length === 0) return normalized

  const hasDebugEcho = /(^|\n)\s*debug\s*$|(^|\n)\s*(traceid|prompthash|outcome|intent|opcount|ops)\s*:/im.test(normalized)
  const canonicalized = normalized
    // Normalize common smart quote variants so downstream quoted-text parsing is stable.
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, "\"")
    // Light typo normalization for frequently used edit verbs/nouns.
    .replace(/\btestomonials\b/gi, "testimonials")
    .replace(/\bfetures\b/gi, "features")
    .replace(/\bheding\b/gi, "heading")
    .replace(/\bad a\b/gi, "add a")
    .replace(/\bupdte\b/gi, "update")
  if (!hasDebugEcho) return canonicalized

  const promptEcho = canonicalized.match(/(^|\n)\s*prompt\s*:\s*(.+)$/im)?.[2]?.trim()
  if (promptEcho && promptEcho.length > 0) return promptEcho

  const cleanedLines = canonicalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      if (line.trim().length === 0) return true
      if (/^\s*debug\s*$/i.test(line)) return false
      if (/^\s*(traceid|prompthash|outcome|intent|opcount|optypes|ops|reason|reasoncategory)\s*:/i.test(line)) return false
      if (/^\s*renamed the hero secondary cta\.?\s*$/i.test(line)) return false
      if (/^\s*performance awareness\b/i.test(line)) return false
      if (/semantic relevance and supports seo,\s*accessibility,\s*and conversion checks\.?\s*$/i.test(line)) return false
      return true
    })
  return cleanedLines.join("\n").trim()
}

export function inferTranslationScopeFromMessage(message: string): TranslationScope {
  const lower = message.toLowerCase()
  const isTranslation =
    /\btranslate\b/.test(lower) ||
    /\btranslation\b/.test(lower) ||
    /\blocaliz/.test(lower) ||
    /\bgerman\b/.test(lower) ||
    /\bdeutsch\b/.test(lower)
  if (!isTranslation) return "none"

  const pageScope =
    /\b(this|the|entire|whole|full)\s+page\b/.test(lower) ||
    /\bwhole\s+site\b/.test(lower) ||
    /\ball\s+sections?\b/.test(lower) ||
    /\btranslate\s+page\b/.test(lower)
  if (pageScope) return "page"

  const componentScope =
    /\b(this|selected|current)\s+(block|section|component)\b/.test(lower) ||
    /\btranslate\s+(the\s+)?(block|section|component)\b/.test(lower) ||
    /\bselected\s+component\b/.test(lower)
  if (componentScope) return "component"

  // Default translation intent to page scope unless the user explicitly narrows it.
  return "page"
}

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
}

export function findFullPageTranslationCoverageGap(args: {
  plan: EditPlan
  message: string
  currentPage: PageDoc
  slug: string
}) {
  if (inferTranslationScopeFromMessage(args.message) !== "page") return null
  if (args.plan.intent !== "edit_plan") return null

  const blockMeta = getAllBlockMeta()
  const touchedBlockIds = new Set(
    args.plan.ops
      .filter((op) => {
        if (!(op.op === "update_props" || op.op === "update_item" || op.op === "add_item" || op.op === "remove_item" || op.op === "move_item")) return false
        return "pageSlug" in op && op.pageSlug === args.slug
      })
      .map((op) => ("blockId" in op ? op.blockId : ""))
      .filter((id) => typeof id === "string" && id.length > 0)
  )
  if (touchedBlockIds.size === 0) return null

  const missingPaths: string[] = []
  for (const block of args.currentPage.blocks) {
    if (!touchedBlockIds.has(block.id)) continue
    const meta = blockMeta[block.type as BlockType]
    const listFields = meta?.listFields ?? {}
    const listEntries = Object.entries(listFields)
    if (listEntries.length === 0) continue

    for (const [listKey, listMeta] of listEntries) {
      const translatableItemFields = Object.entries(listMeta.itemFields ?? {})
        .filter(([, fieldMeta]) => fieldMeta.kind === "text" || fieldMeta.kind === "richtext" || fieldMeta.kind === "imageAlt")
        .map(([key]) => key)
      if (translatableItemFields.length === 0) continue

      const listValue = (block.props as Record<string, unknown>)[listKey]
      if (!Array.isArray(listValue) || listValue.length === 0) continue
      const perItemCoverage = new Map<number, Set<string>>()
      const ensureCoverage = (index: number) => {
        const existing = perItemCoverage.get(index)
        if (existing) return existing
        const next = new Set<string>()
        perItemCoverage.set(index, next)
        return next
      }

      for (const op of args.plan.ops) {
        if (!("pageSlug" in op) || op.pageSlug !== args.slug) continue
        if (op.op === "update_item" && op.blockId === block.id && op.listKey === listKey) {
          const patch = op.patch as Record<string, unknown>
          const cov = ensureCoverage(op.index)
          for (const key of translatableItemFields) {
            if (isNonEmptyString(patch[key])) cov.add(key)
          }
          continue
        }
        if (op.op === "update_props" && op.blockId === block.id) {
          const patch = op.patch as Record<string, unknown>
          if (!Array.isArray(patch[listKey])) continue
          const rows = patch[listKey] as unknown[]
          for (let idx = 0; idx < rows.length; idx += 1) {
            const rowPatch = rows[idx]
            if (!rowPatch || typeof rowPatch !== "object" || Array.isArray(rowPatch)) continue
            const row = rowPatch as Record<string, unknown>
            const cov = ensureCoverage(idx)
            for (const key of translatableItemFields) {
              if (isNonEmptyString(row[key])) cov.add(key)
            }
          }
        }
      }

      for (let idx = 0; idx < listValue.length; idx += 1) {
        const item = listValue[idx]
        if (!item || typeof item !== "object" || Array.isArray(item)) continue
        const row = item as Record<string, unknown>
        const required = translatableItemFields.filter((key) => isNonEmptyString(row[key]))
        if (required.length === 0) continue
        const covered = perItemCoverage.get(idx) ?? new Set<string>()
        const missing = required.filter((key) => !covered.has(key))
        for (const field of missing) missingPaths.push(`${block.id}.${listKey}[${idx}].${field}`)
      }
    }
  }

  if (missingPaths.length === 0) return null
  return `Invalid full-page translation coverage for list children. Missing translated fields: ${missingPaths.join(", ")}`
}

// ---------------------------------------------------------------------------
// Unsplash hero image rewrite
// ---------------------------------------------------------------------------

export async function withUnsplashHeroImage(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  preferredImageOps?: PendingImageGeneration[]
  activeBlockId?: string
  activeEditablePath?: string
  chatRequestId?: string
  log: FastifyBaseLogger
  onStatusUpdate?: (message: string) => void
}): Promise<EditPlan> {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return args.plan

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const userImagePrompt = extractImagePromptFromMessage(args.message)
  args.log.info(
    {
      event: "hero_image_rewrite_start",
      chatRequestId: args.chatRequestId,
      slug: args.slug,
      explicitUnsplashRequest,
      explicitImageGen,
      hasUserImagePrompt: Boolean(userImagePrompt),
      message: args.message
    },
    "Evaluating hero image rewrite"
  )

  const plan = rewriteAddBlockToChildImageUpdate({
    plan: structuredClone(args.plan),
    message: args.message,
    currentPage: args.currentPage,
    slug: args.slug
  })
  let changed = false
  let placeholderSkipped = false
  let resolvedImageCount = 0
  let skippedImageCount = 0
  const globalUsedImageUrls = new Set<string>()
  let sourceQuery: string | undefined
  let imageSource: "ai-generated" | "unsplash" | "placeholder" = "placeholder"
  const preferredQueries = new Map<string, string>()
  for (const item of args.preferredImageOps ?? []) {
    const query = typeof item.query === "string" ? item.query.trim() : ""
    if (!query) continue
    const key = `${item.pageSlug}::${item.blockId}::${item.path ?? "imageUrl"}`
    preferredQueries.set(key, query)
  }

  for (const op of plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target) continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const touchesImage =
      detectImagePaths(patchCandidate).size > 0 ||
      args.activeEditablePath === "imageUrl" ||
      /\b(images?|photos?|pictures?)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const targets = findImageTargets({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    const hasAnyImageTarget = targets.length > 0
    const hasImageUrlInPatch = detectImagePaths(patchCandidate).size > 0
    const shouldReplace =
      !userProvidedExplicitUrl && touchesImage && hasAnyImageTarget && (explicitUnsplashRequest || hasImageUrlInPatch || explicitImageGen)
    if (!touchesImage || !shouldReplace || targets.length === 0) continue

    const targetProps = target.props as Record<string, unknown>
    const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
    const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
    const title = typeof targetProps.title === "string" ? targetProps.title : ""
    const body = typeof targetProps.body === "string" ? targetProps.body : ""
    const sectionContext = [heading, subheading, title, body].filter(Boolean).join(" — ")

    for (const targetImage of targets) {
      const preferredKey = `${op.pageSlug}::${op.blockId}::${targetImage.path}`
      const imageQuery = preferredQueries.get(preferredKey) ?? targetImage.query
      const currentImageUrl = typeof getValueAtPath(targetProps, targetImage.path) === "string"
        ? String(getValueAtPath(targetProps, targetImage.path))
        : ""

      let resolved: UnsplashImage | null = null
      if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY) {
        args.onStatusUpdate?.("Generating image...")
        let generatedPrompt: string
        let generatedAlt: string
        if (userImagePrompt) {
          generatedAlt = userImagePrompt.slice(0, 200)
          generatedPrompt = [
            "Use case: website section image",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${target.type} — ${sectionContext}`,
            userImagePrompt,
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        } else {
          generatedAlt = `AI-generated ${target.type} image featuring ${imageQuery}`
          generatedPrompt = [
            "Use case: website section image update",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${target.type} — ${sectionContext}`,
            `Primary subject: ${imageQuery}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        }
        resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        if (resolved) imageSource = "ai-generated"
      }
      if (!resolved) {
        args.onStatusUpdate?.("Finding a suitable image...")
        if (currentImageUrl) globalUsedImageUrls.add(currentImageUrl)
        const usedImageUrls = globalUsedImageUrls.size > 0 ? globalUsedImageUrls : undefined
        resolved = await resolveUnsplashImage(
          imageQuery,
          { subjectKeywords: imageKeywordsFromQuery(imageQuery, 4), usedImageUrls },
          { chatRequestId: args.chatRequestId, logger: args.log }
        )
        if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
      }

      if (!resolved || (imageSource === "placeholder" && !explicitUnsplashRequest && !explicitImageGen && !userImagePrompt)) {
        deleteValueAtPath(patchCandidate, targetImage.path)
        deleteValueAtPath(patchCandidate, targetImage.altPath)
        args.log.warn(
          { event: "image_rewrite_skip_placeholder", chatRequestId: args.chatRequestId, query: imageQuery, path: targetImage.path },
          "Skipping placeholder image — no relevant image source available"
        )
        placeholderSkipped = true
        skippedImageCount++
        continue
      }

      setValueAtPath(patchCandidate, targetImage.path, resolved.url)
      const existingAlt = getValueAtPath(patchCandidate, targetImage.altPath)
      const nextAlt = preferredImageAltText({
        query: imageQuery,
        resolvedAlt: resolved.alt,
        existingAlt: typeof existingAlt === "string" ? existingAlt : undefined
      })
      if (nextAlt.trim().length > 0) setValueAtPath(patchCandidate, targetImage.altPath, nextAlt)
      sourceQuery = resolved.query
      args.log.info(
        {
          event: "image_rewrite_applied",
          chatRequestId: args.chatRequestId,
          slug: args.slug,
          blockId: op.blockId,
          query: imageQuery,
          explicitUnsplashRequest,
          path: targetImage.path,
          nextImageUrl: resolved.url,
          nextImageAlt: getValueAtPath(patchCandidate, targetImage.altPath)
        },
        "Applied image rewrite"
      )
      changed = true
      resolvedImageCount++
      globalUsedImageUrls.add(resolved.url)
    }
    op.patch = patchCandidate
  }

  // Also resolve Hero images inside create_page ops (new pages with embedded Hero blocks).
  for (const op of plan.ops) {
    if (op.op !== "create_page") continue
    const page = (op as unknown as { page: PageDoc }).page
    if (!page?.blocks) continue
    for (const block of page.blocks) {
      if (block.type !== "Hero") continue
      const props = block.props as Record<string, unknown>
      const placeholderUrl = typeof props.imageUrl === "string" ? props.imageUrl.trim() : ""
      // Skip if the user provided an explicit URL in the message
      if (firstUrlFromText(args.message)) continue
      // Resolve when the Hero has no image or a local placeholder path (e.g. /hero-generated.svg).
      // Preserve explicit remote URLs that the planner/user already chose.
      if (shouldResolveCreatePageHeroImage(placeholderUrl)) {
        const heading = typeof props.heading === "string" ? props.heading : ""
        const subheading = typeof props.subheading === "string" ? props.subheading : ""
        const pageTitle = typeof page.title === "string" ? page.title : ""
        const candidates = [heading, subheading, pageTitle].filter(Boolean)
        const query = candidates.length > 0
          ? imageKeywordsFromQuery(candidates.join(" "), 4).join(" ") || pageTitle || "hero image"
          : "hero image"

        let resolved: UnsplashImage | null = null
        if (process.env.OPENAI_API_KEY) {
          args.onStatusUpdate?.("Generating image for new page...")
          const sectionContext = [heading, subheading].filter(Boolean).join(" — ")
          const generatedAlt = `AI-generated hero image featuring ${query}`
          const generatedPrompt = [
            "Use case: website hero image for a new page",
            `Page: ${pageTitle} (${page.slug})`,
            `Section: Hero — ${sectionContext}`,
            `Primary subject: ${query}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
          resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        }
        if (!resolved) {
          args.onStatusUpdate?.("Finding image for new page...")
          resolved = await resolveUnsplashImage(query, { subjectKeywords: imageKeywordsFromQuery(query, 4) }, { chatRequestId: args.chatRequestId, logger: args.log })
        }
        if (resolved) {
          props.imageUrl = resolved.url
          props.imageAlt = preferredImageAltText({ query, resolvedAlt: resolved.alt, existingAlt: typeof props.imageAlt === "string" ? props.imageAlt : undefined })
          changed = true
          args.log.info(
            { event: "hero_image_create_page_resolved", chatRequestId: args.chatRequestId, pageSlug: page.slug, query, imageUrl: resolved.url },
            "Resolved hero image for create_page"
          )
        }
      }
    }
  }

  if (!changed && (explicitUnsplashRequest || explicitImageGen) && /\b(images?|photos?|pictures?|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })

      let resolved: UnsplashImage | null = null
      if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY && (explicitImageGen || userImagePrompt)) {
        args.onStatusUpdate?.("Generating image...")
        const targetProps = fallbackHero.props as Record<string, unknown>
        const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
        const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
        const sectionContext = [heading, subheading].filter(Boolean).join(" — ")

        let generatedPrompt: string
        let generatedAlt: string
        if (userImagePrompt) {
          generatedAlt = userImagePrompt.slice(0, 200)
          generatedPrompt = [
            "Use case: website section image",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            userImagePrompt,
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        } else {
          generatedAlt = `AI-generated ${fallbackHero.type} image featuring ${query}`
          generatedPrompt = [
            "Use case: website section image update",
            `Page: ${args.currentPage.title} (${args.slug})`,
            `Section: ${fallbackHero.type} — ${sectionContext}`,
            `Primary subject: ${query}`,
            "Style: photorealistic editorial product photography",
            "Composition: clean landscape frame with clear focal subject",
            "Lighting: natural and vibrant",
            "Constraints: no text, no logos, no watermark"
          ].join("\n")
        }
        resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt, log: args.log })
        if (resolved) imageSource = "ai-generated"
      }
      if (!resolved) {
        args.onStatusUpdate?.("Finding a suitable image...")
        const fbProps = fallbackHero.props as Record<string, unknown>
        const fbCurrentUrl = typeof fbProps.imageUrl === "string" ? fbProps.imageUrl : ""
        const fbUsedUrls = fbCurrentUrl ? new Set([fbCurrentUrl]) : undefined
        resolved = await resolveUnsplashImage(
          query,
          { subjectKeywords: imageKeywordsFromQuery(query, 4), usedImageUrls: fbUsedUrls },
          { chatRequestId: args.chatRequestId, logger: args.log }
        )
        if (resolved) imageSource = resolved.url.includes("unsplash") ? "unsplash" : "placeholder"
      }
      // Don't push a new op just to insert a random placeholder
      if (!resolved || imageSource === "placeholder") {
        placeholderSkipped = true
      } else {
        plan.ops.push({
          op: "update_props",
          pageSlug: args.slug,
          blockId: fallbackHero.id,
          patch: { imageUrl: resolved.url, imageAlt: preferredImageAltText({ query, resolvedAlt: resolved.alt }) }
        })
      sourceQuery = resolved.query
      changed = true
      }
    }
  }

  // Remove update_props ops left with empty patches after image field stripping
  if (placeholderSkipped) {
    plan.ops = plan.ops.filter((op) => {
      if (op.op !== "update_props") return true
      const patch = op.patch as Record<string, unknown>
      const inner =
        patch && typeof patch.props === "object" && patch.props !== null && !Array.isArray(patch.props)
          ? (patch.props as Record<string, unknown>)
          : patch
      return Object.keys(inner).filter((k) => k !== "props").length > 0
    })
  }

  if (placeholderSkipped && !changed) {
    plan.change_log = [
      ...plan.change_log,
      "Could not find a matching image — configure UNSPLASH_ACCESS_KEY for relevant image search."
    ]
  }

  if (changed) {
    const countLabel = resolvedImageCount > 1 ? `${resolvedImageCount} matching images` : "a matching image"
    const sourceLabel =
      imageSource === "ai-generated"
        ? (resolvedImageCount > 1 ? `Generated ${resolvedImageCount} images with AI` : "Generated a new image with AI")
        : imageSource === "unsplash"
          ? `Found ${countLabel} from Unsplash`
          : "Set Hero image from placeholder"
    plan.change_log = [...plan.change_log, `${sourceLabel}.`]
    if (skippedImageCount > 0) {
      plan.change_log = [...plan.change_log, `${skippedImageCount} image${skippedImageCount > 1 ? "s" : ""} could not be resolved.`]
    }
    // Rewrite summary to not mislead about the actual image source
    plan.summary_for_user = plan.summary_for_user
      .replace(/\bUnsplash\s+/gi, "")
      .replace(/\bfrom unsplash\b/gi, "")
      .replace(/\ban?\s+unsplash\b/gi, "a new")
  } else {
    args.log.info(
      {
        event: "image_rewrite_skipped",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        explicitUnsplashRequest,
        message: args.message
      },
      "Skipped image rewrite"
    )
  }

  return plan
}

export function shouldResolveCreatePageHeroImage(imageUrl: string) {
  const normalized = imageUrl.trim()
  if (!normalized) return true
  return !/^https?:\/\//i.test(normalized)
}

// ---------------------------------------------------------------------------
// Synchronous image-op detection (no API calls)
// ---------------------------------------------------------------------------

export function detectImageOps(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): PendingImageGeneration[] {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return []

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  const explicitImageGen = isExplicitImageGenRequest(args.message)
  const results: PendingImageGeneration[] = []

  for (const op of args.plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target) continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const touchesImage =
      detectImagePaths(patchCandidate).size > 0 ||
      args.activeEditablePath === "imageUrl" ||
      /\b(images?|photos?|pictures?)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const targets = findImageTargets({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    const hasImageUrlInPatch = detectImagePaths(patchCandidate).size > 0
    const shouldReplace =
      !userProvidedExplicitUrl &&
      touchesImage &&
      targets.length > 0 &&
      (explicitUnsplashRequest || hasImageUrlInPatch || explicitImageGen)
    if (!touchesImage || !shouldReplace || targets.length === 0) continue

    const provider: PendingImageGeneration["provider"] =
      explicitUnsplashRequest ? "unsplash"
      : process.env.OPENAI_API_KEY ? "auto"
      : "unsplash"

    for (const targetImage of targets) {
      results.push({
        blockId: op.blockId,
        pageSlug: op.pageSlug,
        path: targetImage.path,
        altPath: targetImage.altPath,
        query: targetImage.query,
        provider
      })
    }
  }

  // Fallback: explicit image request targeting a Hero block when no ops matched
  if (results.length === 0 && (explicitUnsplashRequest || explicitImageGen) && /\b(images?|photos?|pictures?|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      blockHasImageUrlProp(selectedBlock)
        ? selectedBlock
        : args.currentPage.blocks.find((block) => blockHasImageUrlProp(block)) ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })
      const provider: PendingImageGeneration["provider"] =
        explicitUnsplashRequest ? "unsplash"
        : process.env.OPENAI_API_KEY ? "auto"
        : "unsplash"
      results.push({ blockId: fallbackHero.id, pageSlug: args.slug, query, provider })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Effective slug resolution
// ---------------------------------------------------------------------------

export function resolveEffectiveSlug(args: { session: string; requestedSlug: string; activeBlockId?: string }) {
  const { session, requestedSlug, activeBlockId } = args
  if (!activeBlockId) return requestedSlug
  const current = getPage(session, requestedSlug)
  if (current?.blocks.some((block) => block.id === activeBlockId)) return requestedSlug
  const draft = getSessionDraft(session)
  for (const [slug, page] of draft) {
    if (page.blocks.some((block) => block.id === activeBlockId)) return slug
  }
  return requestedSlug
}

// ---------------------------------------------------------------------------
// AI insight helpers
// ---------------------------------------------------------------------------

const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
const AI_PERFORMANCE_PREFIX = "__ai_performance__:"

function isRewriteLikeMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrit\w*\b/.test(lower) ||
    /\brephras\w*\b/.test(lower) ||
    /\breword\w*\b/.test(lower) ||
    /\bpolish\w*\b/.test(lower) ||
    /\brefin\w*\b/.test(lower) ||
    /\brefresh\w*\b/.test(lower) ||
    /\btighten\w*\b/.test(lower) ||
    /\bclarif\w*\b/.test(lower) ||
    /\bclean\s*up\b/.test(lower) ||
    /\bfreshen\s*up\b/.test(lower) ||
    /\bredo\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bimprove\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bchange\b.*\b(tone|copy|wording|text|messaging)\b/.test(lower)
  )
}

function isPerformanceAwareMessage(message: string) {
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

function isLikelyTextField(key: string) {
  if (!key) return false
  return !/(^|\.)(?:href|url|image|icon|id)$/i.test(key)
}

function collectChangedTextFields(ops: Operation[]) {
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

function buildMetaChangeLogEntries(ops: Operation[]): string[] {
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

function buildAiInsightChanges(args: { plan: EditPlan; message: string }) {
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
// Deterministic create page shortcut
// ---------------------------------------------------------------------------

function deterministicCreatePagePlan(args: { session: string; message: string }) {
  const requestedSlug = parseCreatePageRequest(args.message)
  if (!requestedSlug) return null

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

function deterministicDuplicatePagePlan(args: { session: string; message: string; effectiveSlug: string }) {
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

function deterministicSelectedTextRewritePlan(args: {
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

  if (!isRewriteLikeMessage(args.message)) return null
  if (inferTranslationScopeFromMessage(args.message) !== "none") return null
  if (!args.activeBlockId) return null
  if (typeof args.activeEditablePath !== "string" || !/^[a-zA-Z0-9_]+$/.test(args.activeEditablePath)) return null

  const target = args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
  if (!target) return null
  const props = target.props as Record<string, unknown>

  const key = args.activeEditablePath
  const existing = props[key]
  if (typeof existing !== "string" || existing.trim().length === 0) return null

  const rewritten = sanitizeRewriteToPlainText(rewriteFromExisting(existing, args.message))
  if (rewritten === existing) return null

  const changedLabel = key.replace(/([A-Z])/g, " $1").toLowerCase()
  return {
    intent: "edit_plan",
    summary_for_user: "Rewrite the selected text content to match your request.",
    change_log: [`Rewrite selected ${changedLabel}.`],
    ops: [{ op: "update_props", pageSlug: args.slug, blockId: target.id, patch: { [key]: rewritten } }]
  } satisfies EditPlan
}

function shouldReturnDeterministicClarification(message: string) {
  const lower = message.toLowerCase()
  return (
    isStandalonePageOperation(message) ||
    /\b(delete|remove)\b.*\b(page|home)\b/.test(lower) ||
    /\b(rename|move)\b.*\bpage\b/.test(lower)
  )
}

// ---------------------------------------------------------------------------
// SSE write helper
// ---------------------------------------------------------------------------

export function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  const stream = reply.raw as NodeJS.WritableStream & {
    destroyed?: boolean
    writableEnded?: boolean
    writable?: boolean
  }
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // Client disconnected; ignore write errors for SSE.
  }
}

function sleepMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs))
}

// ---------------------------------------------------------------------------
// Main chat pipeline
// ---------------------------------------------------------------------------

export async function runChatPipeline(
  ctx: ChatPipelineContext,
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onPlannedOp?: (event: { index: number; op: Operation }) => void
    onOpApplied?: (event: { index: number; total: number; op: Operation; previewVersion: number; focusBlockId?: string }) => void
    onOpSkipped?: (event: { index: number; total: number; op: Operation; reason: SkippedOperation["reason"] }) => void
    onStatusUpdate?: (message: string) => void
    onPlanMeta?: (event: { intent: EditPlan["intent"]; summary: string; estimatedOps: number }) => void
    onRollbackStarted?: (event: { appliedCount: number; reason: string }) => void
    onRollbackDone?: (event: { restoredVersion: number }) => void
  }
): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  let executionMode = body.executionMode ?? "auto"
  const requiresMessage = executionMode === "auto" || executionMode === "plan_only"
  if (!body.session || !body.slug || (requiresMessage && !body.message)) {
    return { code: 400, payload: { error: "session and slug are required; message is required for planning" } }
  }
  const manifestPayload = (() => {
    if (!body.componentsManifest) return undefined
    if (typeof body.componentsManifest !== "string") return body.componentsManifest
    try {
      return JSON.parse(body.componentsManifest) as unknown
    } catch {
      return "__invalid_json__"
    }
  })()
  const parsedManifest =
    manifestPayload === "__invalid_json__"
      ? { success: false as const }
      : manifestPayload
        ? editorComponentsManifestSchema.safeParse(manifestPayload)
        : { success: true as const, data: undefined }
  if (!parsedManifest.success) {
    return { code: 400, payload: { error: "invalid componentsManifest payload" } }
  }
  const componentsManifest: EditorComponentsManifest | undefined = parsedManifest.data
  const capabilitiesPayload = (() => {
    if (!body.siteCapabilities) return undefined
    if (typeof body.siteCapabilities !== "string") return body.siteCapabilities
    try {
      return JSON.parse(body.siteCapabilities) as unknown
    } catch {
      return "__invalid_json__"
    }
  })()
  const parsedCapabilities =
    capabilitiesPayload === "__invalid_json__"
      ? { success: false as const }
      : capabilitiesPayload
        ? siteCapabilitiesSchema.safeParse(capabilitiesPayload)
        : { success: true as const, data: undefined }
  if (!parsedCapabilities.success) {
    return { code: 400, payload: { error: "invalid siteCapabilities payload" } }
  }
  const siteCapabilities = parsedCapabilities.data
  if (executionMode === "discard_pending_plan") {
    const existing = pendingApprovalPlanBySession.get(body.session)
    if (!existing) {
      const defaultProvider: AIProvider = ctx.availableProviders[0] ?? "openai"
      const defaultModelKey: ModelKey = (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
      return {
        code: 200,
        payload: {
          status: "canceled",
          summary: "No pending plan to stop.",
          changes: [],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: ctx.availableProviders.length > 0 ? ctx.availableProviders[0] : "demo",
          modelUsed: ctx.modelLookup[defaultProvider][defaultModelKey],
          modelKey: defaultModelKey
        }
      }
    }
    if (body.pendingPlanId && body.pendingPlanId !== existing.id) {
      return { code: 409, payload: { error: "pending plan mismatch" } }
    }
    pendingApprovalPlanBySession.delete(body.session)
    return {
      code: 200,
      payload: {
        status: "canceled",
        summary: "Stopped. The pending plan was discarded and will not be executed.",
        changes: [],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource: existing.source,
        modelUsed: existing.modelUsed,
        modelKey: existing.modelKey
      }
    }
  }
  const sanitizedMessage = sanitizeMessageForPlanning(body.message ?? "")
  const siteContextBlock = buildSiteContextBlock({
    sitePurpose: body.sitePurpose,
    siteHosting: body.siteHosting,
    businessContext: body.businessContext,
    siteContext: body.siteContext
  })
  // Site context is now passed to the LLM system prompt (cacheable) instead of the user message.
  const plannerMessage = plannerMessageWithPendingContext(body.session, sanitizedMessage)
  const inferredTranslationScope = inferTranslationScopeFromMessage(plannerMessage)
  const translationScope = shouldPreferFocusedTranslation({
    message: plannerMessage,
    inferredScope: inferredTranslationScope,
    activeBlockId: body.activeBlockId
  })
    ? "component"
    : inferredTranslationScope
  const planningActiveBlockId = translationScope === "page" ? undefined : body.activeBlockId
  const planningActiveEditablePath = translationScope === "page" ? undefined : body.activeEditablePath
  const sessionChatHistory = chatHistoryBySession.get(body.session) ?? []
  const chatRequestId = randomUUID()
  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: planningActiveBlockId
  })
  ctx.log.info(
    {
      event: "chat_pipeline_start",
      chatRequestId,
      session: body.session,
      requestedSlug,
      effectiveSlug,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath,
      message: body.message
    },
    "Chat pipeline request received"
  )

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = (() => {
    if (requestedProvider && ctx.availableProviders.includes(requestedProvider)) return requestedProvider
    // Prefer Anthropic by default when available (user can always override via UI/provider param).
    if (!body.provider && ctx.availableProviders.includes("anthropic") && process.env.ANTHROPIC_API_KEY) return "anthropic"
    if (!body.provider && ctx.availableProviders.includes("openai") && process.env.OPENAI_API_KEY) return "openai"
    return ctx.availableProviders[0] ?? "openai"
  })()
  const baseModelKey =
    body.modelKey && ctx.modelLookup[provider][body.modelKey]
      ? body.modelKey
      : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelKey =
    !body.modelKey &&
    baseModelKey !== "fast" &&
    ctx.modelLookup[provider].fast &&
    shouldPreferFastModelForMessage(plannerMessage)
      ? ("fast" as const)
      : baseModelKey
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const plannerSource: "openai" | "anthropic" | "demo" =
    provider === "anthropic" && process.env.ANTHROPIC_API_KEY ? "anthropic" :
    provider === "openai" && process.env.OPENAI_API_KEY ? "openai" :
    process.env.OPENAI_API_KEY ? "openai" :
    process.env.ANTHROPIC_API_KEY ? "anthropic" : "demo"
  const promptHash = ctx.chatTelemetry.promptHash(plannerMessage)
  const promptExcerpt = ctx.chatTelemetry.promptExcerpt(plannerMessage)
  const pipelineStartedAtMs = Date.now()
  const stageTimeline: Array<{
    stage: "request_received" | "first_token" | "first_structured_progress" | "plan_ready" | "first_op_applied" | "done"
    atMs: number
  }> = []
  let planningStartedAtMs: number | null = null
  let planningFinishedAtMs: number | null = null
  let firstPlanningTokenMs: number | null = null
  let planningAttempts = 0
  let imageResolutionDurationMs = 0
  let applyDurationMs: number | undefined
  let firstApplyMs: number | null = null
  let doneStageMarked = false

  const markPlanningStart = () => {
    if (planningStartedAtMs === null) planningStartedAtMs = Date.now()
  }

  const markPlanningFinish = () => {
    planningFinishedAtMs = Date.now()
  }

  const onPlanningToken = (token: string) => {
    if (firstPlanningTokenMs === null) {
      firstPlanningTokenMs = Date.now() - pipelineStartedAtMs
      if (!stageTimeline.some((item) => item.stage === "first_token")) {
        stageTimeline.push({ stage: "first_token", atMs: firstPlanningTokenMs })
      }
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "milestone",
        timelineStage: "first_token",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        totalDurationMs: firstPlanningTokenMs
      })
    }
    options?.onPlanningToken?.(token)
  }

  const markFirstStructuredProgress = () => {
    if (stageTimeline.some((item) => item.stage === "first_structured_progress")) return
    const atMs = Date.now() - pipelineStartedAtMs
    stageTimeline.push({ stage: "first_structured_progress", atMs })
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "milestone",
      timelineStage: "first_structured_progress",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      totalDurationMs: atMs
    })
  }

  const emitStatus = (message: string) => {
    options?.onStatusUpdate?.(message)
    ctx.log.info(
      {
        event: "chat_pipeline_status",
        chatRequestId,
        session: body.session,
        message,
        elapsedMs: Date.now() - pipelineStartedAtMs
      },
      "Chat pipeline status update"
    )
  }

  const planningDurationMs = () =>
    planningStartedAtMs !== null && planningFinishedAtMs !== null
      ? Math.max(0, planningFinishedAtMs - planningStartedAtMs)
      : undefined
  const timingFields = () => ({
    totalDurationMs: Date.now() - pipelineStartedAtMs,
    planningDurationMs: planningDurationMs(),
    firstPlanningTokenMs: firstPlanningTokenMs ?? undefined,
    applyDurationMs,
    imageResolutionDurationMs: imageResolutionDurationMs > 0 ? imageResolutionDurationMs : undefined,
    planningAttempts: planningAttempts > 0 ? planningAttempts : undefined
  })
  const incrementalApplyEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_INCREMENTAL_APPLY ?? "1").trim())
  const streamedApplyMinStepMsRaw = Number(process.env.CHAT_STREAM_APPLY_MIN_STEP_MS ?? 260)
  const streamedApplyMinStepMs =
    Number.isFinite(streamedApplyMinStepMsRaw) && streamedApplyMinStepMsRaw > 0
      ? Math.min(Math.max(Math.trunc(streamedApplyMinStepMsRaw), 1), 2000)
      : 0
  const incrementalPlanStreamEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_INCREMENTAL_PLAN_STREAM ?? "1").trim())
  const withDebugPayload = (
    payload: ChatResult,
    extra?: Partial<NonNullable<ChatResult["debug"]>>
  ): ChatResult => ({
    ...payload,
    debug: {
      traceId: chatRequestId,
      promptHash,
      promptExcerpt,
      timeline: (() => {
        if (!doneStageMarked) {
          doneStageMarked = true
          const doneAtMs = Date.now() - pipelineStartedAtMs
          stageTimeline.push({ stage: "done", atMs: doneAtMs })
          ctx.chatTelemetry.push({
            id: chatRequestId,
            at: new Date().toISOString(),
            phase: "milestone",
            timelineStage: "done",
            session: body.session!,
            requestedSlug,
            effectiveSlug,
            plannerSource,
            modelKey,
            modelUsed,
            promptHash,
            promptExcerpt,
            promptLength: plannerMessage.length,
            totalDurationMs: doneAtMs
          })
        }
        return stageTimeline.slice()
      })(),
      ...(payload.debug ?? {}),
      ...(extra ?? {})
    }
  })
  stageTimeline.push({ stage: "request_received", atMs: 0 })
  ctx.chatTelemetry.push({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "received",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length
  })
  ctx.chatTelemetry.push({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "milestone",
    timelineStage: "request_received",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length,
    totalDurationMs: 0
  })

  if (executionMode === "auto") {
    const existingPendingPlan = pendingApprovalPlanBySession.get(body.session)
    const normalizedIncomingMessage = typeof body.message === "string" ? body.message.trim() : ""
    const normalizedPendingMessage = typeof existingPendingPlan?.originalMessage === "string"
      ? existingPendingPlan.originalMessage.trim()
      : ""
    const replayedPendingPrompt = Boolean(
      existingPendingPlan &&
      (
        existingPendingPlan.promptHash === promptHash ||
        (normalizedIncomingMessage.length > 0 && normalizedPendingMessage.length > 0 && normalizedIncomingMessage === normalizedPendingMessage)
      )
    )
    if (replayedPendingPrompt) {
      executionMode = "apply_pending_plan"
      body.pendingPlanId = body.pendingPlanId ?? existingPendingPlan?.id
    }
  }

  const current = getPage(body.session, effectiveSlug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (body.message && isInfoQuery(body.message)) {
    const info = infoResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: info.code, payload: withDebugPayload(info.payload, { outcome: "info" }) }
  }
  if (body.message && isAdviceQuery(body.message)) {
    pendingClarificationBySession.delete(body.session)
    const advice = adviceResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: advice.code, payload: withDebugPayload(advice.payload, { outcome: "advice" }) }
  }

  emitStatus("Analyzing your request...")

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: planningActiveEditablePath
  })
  const compactContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_COMPACT_CONTEXT_EXPERIMENT ?? "").trim())
  const minimalContextExperimentEnabled = /^(1|true|yes|on)$/i.test((process.env.CHAT_MINIMAL_CONTEXT_EXPERIMENT ?? "").trim())
  const basePlannerContext =
    compactContextExperimentEnabled
      ? compactPlannerContextPack({ contextPack, message: plannerMessage, translationScope })
      : contextPack
  const useMinimalPlannerContext = minimalContextExperimentEnabled && shouldUseMinimalPlannerContext({
    message: plannerMessage,
    translationScope,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })
  const plannerContext =
    useMinimalPlannerContext
      ? minimalPlannerContextPack({ contextPack: basePlannerContext })
      : basePlannerContext
  const contextPackBytes = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(plannerContext), "utf8")
    } catch {
      return undefined
    }
  })()
  const plannerContextTelemetryFields = {
    ...(typeof contextPackBytes === "number" ? { contextPackBytes } : {}),
    compactContextEnabled: compactContextExperimentEnabled,
    minimalContextEnabled: useMinimalPlannerContext
  }

  const guardrailFailureResponse = (args: { reason: string; source: "openai" | "anthropic" | "demo" }) => {
    const category = classifyGuardrailError(args.reason)
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: args.source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "guardrail_failure",
      reason: args.reason.slice(0, 300),
      reasonCategory: category,
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    if (category === "ambiguity") {
      const selected =
        planningActiveBlockId && current.blocks.find((b) => b.id === planningActiveBlockId)
          ? current.blocks.find((b) => b.id === planningActiveBlockId)
          : null
      return {
        code: 200,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "I need one more detail before applying this safely.",
          changes: [],
          mentionedSlugs: [effectiveSlug],
          suggestions: clarificationSuggestions({ body, current, selected }),
          previewVersion: versions.get(body.session!) ?? 0,
          plannerSource: args.source,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "needs_clarification", reasonCategory: category })
      }
    }
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(args.reason)],
        previewVersion: versions.get(body.session!) ?? 0,
        plannerSource: args.source,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "validation_error", reasonCategory: category })
    }
  }

  let planUsage: TokenUsage | undefined

  const respondFromPlan = async (
    plan: EditPlan,
    source: "openai" | "anthropic" | "demo",
    applyMode: "apply_now" | "plan_only" = "apply_now",
    optionsOverride?: { preResolvedPlan?: boolean },
    plannerTier?: "forced_deterministic" | "deterministic" | "llm_intent_router" | "full_llm" | "demo"
  ) => {
    const usageFields = planUsage ? {
      inputTokens: planUsage.inputTokens,
      outputTokens: planUsage.outputTokens,
      totalTokens: planUsage.totalTokens,
      ...(typeof planUsage.cacheCreationInputTokens === "number"
        ? { cacheCreationInputTokens: planUsage.cacheCreationInputTokens }
        : {}),
      ...(typeof planUsage.cacheReadInputTokens === "number"
        ? { cacheReadInputTokens: planUsage.cacheReadInputTokens }
        : {}),
      estimatedUsd: estimateUsd(modelUsed, planUsage)
    } : {}
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "plan_generated",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      intent: plan.intent,
      opCount: plan.ops.length,
      opTypes: plan.ops.map((op) => op.op),
      plannerTier,
      ...plannerContextTelemetryFields,
      ...usageFields,
      ...timingFields()
    })
    let resolvedPlan = plan
    let detectedImageOps: PendingImageGeneration[] = []
    let effectiveApplyMode = applyMode
    if (!optionsOverride?.preResolvedPlan) {
      resolvedPlan = normalizePlanCopyForUi(plan, current)
      resolvedPlan = rewriteAddBlockToChildImageUpdate({
        plan: resolvedPlan,
        message: plannerMessage,
        currentPage: current,
        slug: effectiveSlug
      })

      // Detect image ops synchronously before making any API calls
      detectedImageOps = detectImageOps({
        plan: resolvedPlan,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      if (detectedImageOps.length > 0) {
        // Force plan approval so user can review before expensive image generation
        effectiveApplyMode = "plan_only"

        // Strip placeholder imageUrl values from ops so preview shows current image
        for (const op of resolvedPlan.ops) {
          if (op.op !== "update_props") continue
          const imgOps = detectedImageOps.filter((io) => io.blockId === op.blockId && io.pageSlug === op.pageSlug)
          if (imgOps.length === 0) continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchCandidate =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          for (const imgOp of imgOps) {
            if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
              deleteValueAtPath(patchCandidate, imgOp.path)
            } else {
              delete patchCandidate.imageUrl
            }
            if (typeof imgOp.altPath === "string" && imgOp.altPath.length > 0) {
              deleteValueAtPath(patchCandidate, imgOp.altPath)
            } else {
              delete patchCandidate.imageAlt
            }
          }
        }

        // Annotate change_log with deferred image generation info
        for (const imgOp of detectedImageOps) {
          const pendingImageMessage =
            imgOp.provider === "unsplash"
              ? `Will find an image on Unsplash: "${imgOp.query}".`
              : imgOp.provider === "openai"
                ? `Will generate an image with AI: "${imgOp.query}".`
                : `Will resolve an image for: "${imgOp.query}".`
          resolvedPlan.change_log = [...resolvedPlan.change_log, pendingImageMessage]
        }
      } else {
        // No image ops detected — run withUnsplashHeroImage as before (will be a no-op)
        const imageResolutionStartMs = Date.now()
        emitStatus("Resolving image assets...")
        resolvedPlan = await withUnsplashHeroImage({
          plan: resolvedPlan,
          message: plannerMessage,
          slug: effectiveSlug,
          currentPage: current,
          activeBlockId: planningActiveBlockId,
          activeEditablePath: planningActiveEditablePath,
          chatRequestId,
          log: ctx.log,
          onStatusUpdate: options?.onStatusUpdate
        })
        imageResolutionDurationMs += Date.now() - imageResolutionStartMs
      }

      if (resolvedPlan.intent === "needs_clarification" && planningActiveBlockId) {
        const focusedFallback = compileDeterministicPlan({
          session: body.session ?? "dev",
          intent: { action: "clarify" },
          message: plannerMessage,
          slug: effectiveSlug ?? "/",
          currentPage: current,
          activeBlockId: planningActiveBlockId,
          activeEditablePath: planningActiveEditablePath
        })
        if (focusedFallback?.intent === "edit_plan" && focusedFallback.ops.length > 0) {
          resolvedPlan = focusedFallback
        }
      }
    }

    if (resolvedPlan.intent === "needs_clarification" && body.message && isBlockCatalogQuery(body.message)) {
      const forcedInfo = infoResponse({ body, current, plannerSource: source, modelUsed, modelKey })
      return { done: true as const, response: forcedInfo }
    }

    if (translationScope === "page") {
      const translationCoverageGap = findFullPageTranslationCoverageGap({
        plan: resolvedPlan,
        message: plannerMessage,
        currentPage: current,
        slug: effectiveSlug
      })
      if (translationCoverageGap) return { done: false as const, reason: translationCoverageGap }
    }

    options?.onPlanMeta?.({
      intent: resolvedPlan.intent,
      summary: resolvedPlan.summary_for_user,
      estimatedOps: resolvedPlan.ops.length
    })
    markFirstStructuredProgress()
    if (!stageTimeline.some((item) => item.stage === "plan_ready")) {
      const planReadyAtMs = Date.now() - pipelineStartedAtMs
      stageTimeline.push({ stage: "plan_ready", atMs: planReadyAtMs })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "milestone",
        timelineStage: "plan_ready",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        totalDurationMs: planReadyAtMs
      })
    }

    if (resolvedPlan.intent === "needs_clarification") {
      pendingClarificationBySession.set(body.session!, { baseRequest: plannerMessage, updatedAt: new Date().toISOString() })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "needs_clarification",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      const selected =
        planningActiveBlockId && current.blocks.find((b) => b.id === planningActiveBlockId)
          ? current.blocks.find((b) => b.id === planningActiveBlockId)
          : null
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "needs_clarification",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? clarificationSuggestions({ body, current, selected }),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "needs_clarification",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            ...usageFields
          })
        }
      }
    }

    if (effectiveApplyMode === "plan_only") {
      const pendingPlanId = randomUUID()
      pendingApprovalPlanBySession.set(body.session!, {
        id: pendingPlanId,
        createdAt: new Date().toISOString(),
        promptHash,
        requestedSlug,
        effectiveSlug,
        summary: resolvedPlan.summary_for_user,
        source,
        modelUsed,
        modelKey,
        plan: structuredClone(resolvedPlan),
        originalMessage: plannerMessage,
        ...(detectedImageOps.length > 0 ? { pendingImageOps: detectedImageOps } : {})
      })
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "plan_ready_for_approval",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "plan_ready",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey,
            pendingPlanId
          } satisfies ChatResult, {
            outcome: "plan_ready_for_approval",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            ...usageFields
          })
        }
      }
    }

    const previous = getPage(body.session!, effectiveSlug)
    if (!previous) {
      return {
        done: true as const,
        response: { code: 404, payload: { error: "page not found" } as { error: string } }
      }
    }

    if (resolvedPlan.ops.length === 0) {
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "no_effective_change",
        intent: resolvedPlan.intent,
        opCount: 0,
        opTypes: [],
        plannerTier,
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: "No changes needed. That content is already up to date.",
            changes: [],
            mentionedSlugs: [effectiveSlug],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "no_effective_change" })
        }
      }
    }

    if (siteCapabilities?.allowStructuralEdits === false && resolvedPlan.ops.some((op) => isStructuralOperation(op))) {
      const reason =
        typeof siteCapabilities.reason === "string" && siteCapabilities.reason.trim().length > 0
          ? ` ${siteCapabilities.reason.trim()}`
          : ""
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "needs_clarification",
            summary: `Structural edits are disabled for this site context.${reason}`,
            changes: ["Expose GET /api/editor/components with a valid manifest to enable structural operations."],
            mentionedSlugs: [effectiveSlug],
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, { outcome: "blocked_structural_capability" })
        }
      }
    }

    let applyStartedAtMs: number | null = null
    let skippedOps: SkippedOperation[] = []
    try {
      emitStatus("Applying planned changes...")
      applyStartedAtMs = Date.now()
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (incrementalApplyEnabled && options?.onOpApplied && !hasPageStructuralOps) {
        const rollbackBySlug = new Map<string, PageDoc>()
        for (const op of resolvedPlan.ops) {
          const slugsToSnapshot: string[] = []
          if (op.op === "create_page") slugsToSnapshot.push(op.page.slug)
          else slugsToSnapshot.push(op.pageSlug)
          if (op.op === "duplicate_block" && typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) {
            slugsToSnapshot.push(op.toPageSlug)
          }

          for (const slug of slugsToSnapshot) {
            if (rollbackBySlug.has(slug)) continue
            const existing = getPage(body.session!, slug)
            if (existing) rollbackBySlug.set(slug, structuredClone(existing))
          }
        }

        // Validate the whole plan from the current state before progressive apply.
        const preflight = applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
        skippedOps = preflight.skippedOps

        // Roll back to pre-apply state so we can replay ops progressively.
        for (const [slug, snapshot] of rollbackBySlug) {
          setPage(body.session!, { ...snapshot, slug })
        }
        for (const op of resolvedPlan.ops) {
          if (op.op === "create_page") {
            if (rollbackBySlug.has(op.page.slug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.page.slug)!))
              continue
            }
            const sessionDraft = getSessionDraft(body.session!)
            sessionDraft.delete(op.page.slug)
            continue
          }
          if (op.op === "rename_page") {
            const sessionDraft = getSessionDraft(body.session!)
            if (rollbackBySlug.has(op.newPageSlug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.newPageSlug)!))
            } else {
              sessionDraft.delete(op.newPageSlug)
            }
          }
        }

        const total = resolvedPlan.ops.length
        try {
          for (let index = 0; index < total; index += 1) {
            const stepStartedAtMs = Date.now()
            const op = resolvedPlan.ops[index]
            const stepResult = applyOpsAtomically(body.session!, [op], { componentsManifest })
            if (stepResult.skippedOps.length > 0) {
              for (const skipped of stepResult.skippedOps) {
                options?.onOpSkipped?.({
                  index: index + 1,
                  total,
                  op,
                  reason: skipped.reason
                })
              }
              continue
            }
            if (firstApplyMs === null) {
              firstApplyMs = Date.now() - pipelineStartedAtMs
              stageTimeline.push({ stage: "first_op_applied", atMs: firstApplyMs })
              ctx.chatTelemetry.push({
                id: chatRequestId,
                at: new Date().toISOString(),
                phase: "milestone",
                timelineStage: "first_op_applied",
                session: body.session!,
                requestedSlug,
                effectiveSlug,
                plannerSource: source,
                modelKey,
                modelUsed,
                promptHash,
                promptExcerpt,
                promptLength: plannerMessage.length,
                totalDurationMs: firstApplyMs
              })
            }
            const previewVersion = bumpVersion(body.session!)
            options.onOpApplied({
              index: index + 1,
              total,
              op,
              previewVersion,
              focusBlockId: pickFocusBlockId([op])
            })
            if (streamedApplyMinStepMs > 0 && total > 1 && index < total - 1) {
              const stepElapsedMs = Date.now() - stepStartedAtMs
              const remainingMs = streamedApplyMinStepMs - stepElapsedMs
              if (remainingMs > 0) await sleepMs(remainingMs)
            }
          }
        } catch (progressiveError) {
          options?.onRollbackStarted?.({ appliedCount: total, reason: toErrorDetail(progressiveError) })
          // Roll back to pre-plan state so we don't leave a partially-applied plan.
          for (const [slug, snapshot] of rollbackBySlug) {
            setPage(body.session!, { ...snapshot, slug })
          }
          options?.onRollbackDone?.({ restoredVersion: versions.get(body.session!) ?? 0 })
          throw progressiveError
        }
      } else {
        const applyResult = applyOpsAtomically(body.session!, resolvedPlan.ops, { componentsManifest })
        skippedOps = applyResult.skippedOps
        if (applyResult.appliedCount > 0 && firstApplyMs === null) {
          firstApplyMs = Date.now() - pipelineStartedAtMs
          stageTimeline.push({ stage: "first_op_applied", atMs: firstApplyMs })
          ctx.chatTelemetry.push({
            id: chatRequestId,
            at: new Date().toISOString(),
            phase: "milestone",
            timelineStage: "first_op_applied",
            session: body.session!,
            requestedSlug,
            effectiveSlug,
            plannerSource: source,
            modelKey,
            modelUsed,
            promptHash,
            promptExcerpt,
            promptLength: plannerMessage.length,
            totalDurationMs: firstApplyMs
          })
        }
      }
      pushUndo(body.session!, effectiveSlug, previous)
      pendingClarificationBySession.delete(body.session!)
      pendingApprovalPlanBySession.delete(body.session!)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: resolvedPlan.summary_for_user, ops: resolvedPlan.ops })
      if (body.message) pushChatHistory(body.session!, body.message, resolvedPlan.summary_for_user)
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      schedulePersistState(ctx.log)
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      const aiInsightChanges = buildAiInsightChanges({ plan: resolvedPlan, message: plannerMessage })
      const metaChangeLogEntries = buildMetaChangeLogEntries(resolvedPlan.ops)
      const skippedSummary =
        skippedOps.length > 0
          ? [`Skipped ${skippedOps.length} unchanged operation${skippedOps.length === 1 ? "" : "s"}.`]
          : []
      applyDurationMs = applyStartedAtMs !== null ? Date.now() - applyStartedAtMs : undefined
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "applied",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op),
        skippedOpCount: skippedOps.length > 0 ? skippedOps.length : undefined,
        plannerTier,
        ...plannerContextTelemetryFields,
        ...usageFields,
        ...timingFields()
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: resolvedPlan.summary_for_user,
            changes: [...resolvedPlan.change_log, ...metaChangeLogEntries, ...aiInsightChanges, ...skippedSummary],
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
            suggestions: resolvedPlan.suggested_next_actions ?? postEditSuggestions({ plan: resolvedPlan, current, body }),
            previewVersion,
            focusBlockId,
            updatedSlug,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "applied",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op),
            skippedOpCount: skippedOps.length,
            skippedOps,
            ...usageFields
          })
        }
      }
    } catch (error) {
      if (applyDurationMs === undefined && applyStartedAtMs !== null) {
        applyDurationMs = Date.now() - applyStartedAtMs
      }
      const reason = toErrorDetail(error)
      if (isNoEffectiveChangeError(reason)) {
        pendingApprovalPlanBySession.delete(body.session!)
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session!,
          requestedSlug,
          effectiveSlug,
          plannerSource: source,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "no_effective_change",
          reason: reason.slice(0, 300),
          plannerTier,
          ...plannerContextTelemetryFields,
          ...timingFields()
        })
        return {
          done: true as const,
          response: {
            code: 200,
            payload: withDebugPayload({
              status: "applied",
              summary: "No changes needed. That content is already up to date.",
              changes: [],
              mentionedSlugs: [effectiveSlug],
              previewVersion: versions.get(body.session!) ?? 0,
              plannerSource: source,
              modelUsed,
              modelKey
            } satisfies ChatResult, { outcome: "no_effective_change" })
          }
        }
      }
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_apply_failed",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "apply_failed",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        plannerTier,
        ...timingFields()
      })
      return { done: false as const, reason }
    }
  }

  if (executionMode === "apply_pending_plan") {
    const pending = pendingApprovalPlanBySession.get(body.session)
    if (!pending) {
      const fallbackMessage = typeof body.message === "string" ? body.message.trim() : ""
      if (fallbackMessage.length > 0) {
        return runChatPipeline(ctx, { ...body, executionMode: "auto" }, options)
      }
      return {
        code: 409,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "No pending plan is waiting for approval. Ask for a change first.",
          changes: [],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "pending_plan_missing" })
      }
    }
    if (body.pendingPlanId && body.pendingPlanId !== pending.id) {
      return {
        code: 409,
        payload: withDebugPayload({
          status: "validation_error",
          summary: "Pending plan does not match the latest reviewed plan.",
          changes: [],
          validationErrors: ["Pending plan id mismatch. Refresh and approve again."],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "pending_plan_mismatch" })
      }
    }
    // Run deferred image generation if the pending plan has image ops
    let approvalPlan = pending.plan
    try {
      if (pending.pendingImageOps && pending.pendingImageOps.length > 0) {
        const imageResolutionStartMs = Date.now()
        emitStatus("Resolving image assets...")
        const imageMessage = pending.originalMessage ?? (typeof body.message === "string" ? body.message : "")
        const planClone = structuredClone(approvalPlan)

        // Restore placeholder imageUrl in ops that had it stripped during detection.
        // withUnsplashHeroImage checks requestedImageUrl.length > 0 to decide whether
        // to resolve an image — without this, the stripped patch causes it to skip.
        for (const imgOp of pending.pendingImageOps) {
          const op = planClone.ops.find(
            (o) => o.op === "update_props" && o.blockId === imgOp.blockId && o.pageSlug === imgOp.pageSlug
          )
          if (!op || op.op !== "update_props") continue
          const rawPatch = op.patch as Record<string, unknown>
          const patchTarget =
            rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
              ? (rawPatch.props as Record<string, unknown>)
              : rawPatch
          if (typeof imgOp.path === "string" && imgOp.path.length > 0) {
            if (getValueAtPath(patchTarget, imgOp.path) === undefined) {
              setValueAtPath(patchTarget, imgOp.path, "pending")
            }
          } else if (!Object.prototype.hasOwnProperty.call(patchTarget, "imageUrl")) {
            patchTarget.imageUrl = "pending"
          }
        }

        approvalPlan = await withUnsplashHeroImage({
          plan: planClone,
          message: imageMessage,
          slug: pending.effectiveSlug,
          currentPage: current,
          preferredImageOps: pending.pendingImageOps,
          activeBlockId: body.activeBlockId,
          activeEditablePath: body.activeEditablePath,
          chatRequestId,
          log: ctx.log,
          onStatusUpdate: options?.onStatusUpdate
        })
        imageResolutionDurationMs += Date.now() - imageResolutionStartMs
      }
      const approvedOutcome = await respondFromPlan(approvalPlan, pending.source, "apply_now", { preResolvedPlan: true })
      if (approvedOutcome.done) return approvedOutcome.response
      return guardrailFailureResponse({ reason: approvedOutcome.reason, source: pending.source })
    } catch (error) {
      const reason = toErrorDetail(error)
      ctx.log.error({ event: "apply_pending_plan_error", chatRequestId, error: reason }, "Pending plan execution failed")
      pendingApprovalPlanBySession.delete(body.session!)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: pending.source,
        modelKey: pending.modelKey,
        modelUsed: pending.modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "apply_pending_plan_error",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        code: 500,
        payload: withDebugPayload({
          status: "error",
          summary: "Failed to execute the approved plan. Please try again.",
          changes: [reason.slice(0, 300)],
          previewVersion: versions.get(body.session!) ?? 0,
          plannerSource: pending.source,
          modelUsed: pending.modelUsed,
          modelKey: pending.modelKey
        } satisfies ChatResult, { outcome: "apply_pending_plan_error" })
      }
    }
  }

  const applyMode = executionMode === "plan_only" ? "plan_only" : "apply_now"

  markPlanningStart()
  emitStatus("Planning edits...")
  const forcedDuplicatePlan = deterministicDuplicatePagePlan({ session: body.session, message: plannerMessage, effectiveSlug })
  if (forcedDuplicatePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_duplicate_page",
      intent: forcedDuplicatePlan.intent,
      opCount: forcedDuplicatePlan.ops.length,
      opTypes: forcedDuplicatePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedDuplicatePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  const forcedSelectedRewritePlan = deterministicSelectedTextRewritePlan({
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })
  if (forcedSelectedRewritePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_rewrite_selected_text",
      intent: forcedSelectedRewritePlan.intent,
      opCount: forcedSelectedRewritePlan.ops.length,
      opTypes: forcedSelectedRewritePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedSelectedRewritePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  const forcedCreatePlan = deterministicCreatePagePlan({ session: body.session, message: plannerMessage })
  if (forcedCreatePlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_create_page",
      intent: forcedCreatePlan.intent,
      opCount: forcedCreatePlan.ops.length,
      opTypes: forcedCreatePlan.ops.map((op) => op.op),
      plannerTier: "forced_deterministic",
      ...timingFields()
    })
    const forcedOutcome = await respondFromPlan(forcedCreatePlan, plannerSource, applyMode, undefined, "forced_deterministic")
    if (forcedOutcome.done) return forcedOutcome.response
  }

  if (plannerSource === "demo") {
    markPlanningStart()
    try {
      emitStatus("Planning edits...")
      const demoPlan = demoPlanFromMessageImpl(plannerMessage, effectiveSlug, planningActiveBlockId, body.activeBlockType)
      markPlanningFinish()
      const outcome = await respondFromPlan(demoPlan, "demo", applyMode, undefined, "demo")
      if (outcome.done) return outcome.response
      return guardrailFailureResponse({ reason: outcome.reason, source: "demo" })
    } catch (error) {
      markPlanningFinish()
      const reason = toErrorDetail(error)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource: "demo",
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "planner_exception",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        plannerTier: "demo",
        ...plannerContextTelemetryFields,
        ...timingFields()
      })
      return {
        code: 500,
        payload: withDebugPayload({
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [reason.slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }, { outcome: "planner_exception", reasonCategory: classifyGuardrailError(reason) })
      }
    }
  }

  const isHighConfidence = isHighConfidenceDeterministicCase({
    message: plannerMessage,
    currentPage: current,
    activeBlockId: planningActiveBlockId,
    activeEditablePath: planningActiveEditablePath
  })

  if (isHighConfidence) {
    const deterministicIntent = inferDeterministicIntent({
      message: plannerMessage,
      currentPage: current,
      activeBlockId: planningActiveBlockId,
      activeEditablePath: planningActiveEditablePath
    })

    if (deterministicIntent) {
      emitStatus("Planning edits...")
      const deterministicPlan = compileDeterministicPlan({
        session: body.session,
        intent: deterministicIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      if (deterministicPlan?.intent === "edit_plan" && deterministicPlan.ops.length > 0) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "deterministic_plan_ready",
          intent: deterministicPlan.intent,
          opCount: deterministicPlan.ops.length,
          opTypes: deterministicPlan.ops.map((op) => op.op),
          plannerTier: "deterministic"
        })
        const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode, undefined, "deterministic")
        if (deterministicOutcome.done) return deterministicOutcome.response
      }

      if (
        deterministicPlan?.intent === "needs_clarification" &&
        shouldReturnDeterministicClarification(plannerMessage)
      ) {
        markPlanningFinish()
        const deterministicOutcome = await respondFromPlan(deterministicPlan, plannerSource, applyMode, undefined, "deterministic")
        if (deterministicOutcome.done) return deterministicOutcome.response
      }
    }
  }

  const llmIntentRouterEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_LLM_INTENT_ROUTER ?? "1").trim())
  const shouldTryLlmIntentRouter =
    llmIntentRouterEnabled &&
    shouldUseLlmIntentRouter(plannerMessage) &&
    (plannerSource === "openai" || plannerSource === "anthropic")

  if (shouldTryLlmIntentRouter) {
    try {
      emitStatus("Understanding your request...")
      const routerModel =
        ctx.modelLookup[provider]?.fast ??
        ctx.modelLookup[provider]?.balanced ??
        modelUsed

      const routedIntent =
        plannerSource === "anthropic"
          ? await parseIntentWithAnthropicImpl({
              message: plannerMessage,
              slug: effectiveSlug,
              currentPage: current,
              activeBlockId: planningActiveBlockId,
              activeBlockType: body.activeBlockType,
              activeEditablePath: planningActiveEditablePath,
              model: routerModel
            })
          : await parseIntentWithOpenAIImpl({
              message: plannerMessage,
              slug: effectiveSlug,
              currentPage: current,
              activeBlockId: planningActiveBlockId,
              activeBlockType: body.activeBlockType,
              activeEditablePath: planningActiveEditablePath,
              model: routerModel
            })

      emitStatus("Planning edits...")
      const routedPlan = compileDeterministicPlan({
        session: body.session,
        intent: routedIntent,
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        activeBlockId: planningActiveBlockId,
        activeEditablePath: planningActiveEditablePath
      })

      if (routedPlan?.intent === "edit_plan" && routedPlan.ops.length > 0) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "llm_router_plan_ready",
          intent: routedPlan.intent,
          opCount: routedPlan.ops.length,
          opTypes: routedPlan.ops.map((op) => op.op),
          plannerTier: "llm_intent_router",
          ...timingFields()
        })
        const routedOutcome = await respondFromPlan(routedPlan, plannerSource, applyMode, undefined, "llm_intent_router")
        if (routedOutcome.done) return routedOutcome.response
      }

      if (routedPlan?.intent === "needs_clarification" && shouldReturnDeterministicClarification(plannerMessage)) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "deterministic_plan_generated",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "llm_router_needs_clarification",
          intent: routedPlan.intent,
          opCount: 0,
          opTypes: [],
          plannerTier: "llm_intent_router",
          ...timingFields()
        })
        const routedOutcome = await respondFromPlan(routedPlan, plannerSource, applyMode, undefined, "llm_intent_router")
        if (routedOutcome.done) return routedOutcome.response
      }
    } catch {
      // If router fails, fall back to the full planner.
    }
  }

  const generatePlanImpl = plannerSource === "anthropic" ? generatePlanWithAnthropicImpl : generatePlanWithOpenAIImpl
  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  const planningErrors: string[] = []
  markPlanningStart()

  for (let attempt = 1; attempt <= maxPlanningAttempts; attempt += 1) {
    planningAttempts = attempt
    try {
      emitStatus(attempt === 1 ? "Planning edits..." : `Retrying plan generation (${attempt}/${maxPlanningAttempts})...`)
      const result = await generatePlanImpl({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack: plannerContext,
        model: modelUsed,
        history: sessionChatHistory,
        siteContextBlock,
        onToken: onPlanningToken,
        onPlannedOp: incrementalPlanStreamEnabled
          ? (op, index) => {
              markFirstStructuredProgress()
              options?.onPlannedOp?.({ op, index })
            }
          : undefined
      })
      initialPlan = result.plan
      planUsage = result.usage
      markPlanningFinish()
      break
    } catch (error) {
      const reason = toErrorDetail(error)
      ctx.chatTelemetry.push({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_attempt_failed",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: `attempt_${attempt}_failed`,
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason),
        ...timingFields()
      })
      planningErrors.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxPlanningAttempts) {
        markPlanningFinish()
        ctx.chatTelemetry.push({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "planning_exhausted",
          reason: reason.slice(0, 300),
          reasonCategory: classifyGuardrailError(reason),
          plannerTier: "full_llm",
          ...plannerContextTelemetryFields,
          ...timingFields()
        })
        return {
          code: 500,
          payload: withDebugPayload({
            status: "error",
            summary: "Could not generate an edit plan.",
            changes: [reason.slice(0, 300)],
            validationErrors: planningErrors.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }, { outcome: "planning_exhausted", reasonCategory: classifyGuardrailError(reason) })
        }
      }
    }
  }

  if (!initialPlan) {
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "planning_missing",
      plannerTier: "full_llm",
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    return {
      code: 500,
      payload: withDebugPayload({
        status: "error",
        summary: "Could not generate an edit plan.",
        changes: [],
        validationErrors: planningErrors.slice(-3),
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "planning_missing" })
    }
  }

  const initialOutcome = await respondFromPlan(initialPlan, plannerSource, applyMode, undefined, "full_llm")
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: plannerSource })
  }

  let repairedPlan: EditPlan
  try {
    emitStatus("Repairing plan and retrying...")
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_attempt",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_started",
      reason: initialOutcome.reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(initialOutcome.reason),
      ...timingFields()
    })
    planningAttempts += 1
    const repairFeedback = /full-page translation coverage/i.test(initialOutcome.reason)
      ? `${initialOutcome.reason}. Repair for translation completeness: include missing translated text fields for list children across all affected blocks. Preserve links/hrefs unchanged.`
      : buildDeterministicRepairFeedback(initialOutcome.reason)
    const repairResult = await generatePlanImpl({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack: plannerContext,
      model: modelUsed,
      history: sessionChatHistory,
      feedback: repairFeedback,
      siteContextBlock,
      onToken: onPlanningToken,
      onPlannedOp: incrementalPlanStreamEnabled
        ? (op, index) => {
            markFirstStructuredProgress()
            options?.onPlannedOp?.({ op, index })
          }
        : undefined
    })
    repairedPlan = repairResult.plan
    planUsage = repairResult.usage
    markPlanningFinish()
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_generated",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_plan_generated",
      intent: repairedPlan.intent,
      opCount: repairedPlan.ops.length,
      opTypes: repairedPlan.ops.map((op) => op.op),
      ...timingFields()
    })
  } catch (error) {
    markPlanningFinish()
    const reason = toErrorDetail(error)
    ctx.chatTelemetry.push({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_failed",
      reason: reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(reason),
      ...plannerContextTelemetryFields,
      ...timingFields()
    })
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(reason)],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "repair_failed", reasonCategory: classifyGuardrailError(reason) })
    }
  }

  const repairedOutcome = await respondFromPlan(repairedPlan, plannerSource, applyMode)
  if (repairedOutcome.done) return repairedOutcome.response
  return guardrailFailureResponse({ reason: repairedOutcome.reason, source: plannerSource })
}
