import { z } from "zod"
import {
  allowedBlockTypes,
  IMAGE_PLACEHOLDER,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  extractRouteMentions,
  normalizeRouteCandidate,
  parseCreatePageRequest,
  requestsContentGeneration,
  toSeedSlug
} from "./intent-helpers.js"
import {
  isBatchAddRequest,
  stripSiteContextEnvelope,
  extractMentionedBlockTypes
} from "./intent-detection.js"
import {
  defaultPropsForType,
  inferBlockTypeFromText,
  nextBlockId
} from "./plan-normalizer.js"
import {
  getSessionDraft
} from "../state/session-state.js"
import {
  readPathValue,
  selectedBlockSnapshot,
  arrayPropLengths,
  pageIntentSummary,
  plannerContextPack,
  resolveImageUrlForAltField,
  fetchImageAsBase64
} from "./deterministic-planner-context.js"
import {
  inferAddedBlockTypeFromMessage,
  resolveBlockRef,
  ordinalToIndex,
  resolveByDescriptor,
  resolveReferencesFromMessage
} from "./deterministic-planner-refs.js"
import { EXCEPT_PATTERN, THIS_ONE_PATTERN } from "./intent-patterns.js"
import {
  extractAudienceTargets,
  titleCaseWords,
  audiencePatchForBlock,
  coercePatchForBlock,
  inferSimpleFieldPatchFromMessage,
  isRewriteRequest,
  shouldKeepRichTextTitleOnTranslate,
  inferFieldHintFromMessage,
  coercePatchForEditablePath,
  quotedText,
  buildListAppendPatch
} from "./deterministic-planner-patches.js"
import {
  userFacingPropNames
} from "./deterministic-planner-suggestions.js"
import { st } from "../chat/locale-strings.js"
import {
  buildCreatePagePlan,
  isPageRouteRenameRequest
} from "./deterministic-planner-pages.js"


const CONTAINER_BLOCK_TYPES = /\b(carousel|slideshow|slider|cardgrid|card\s*grid|faqaccordion|faq|testimonials?|featuregrid|feature\s*grid|gallery|tabs?|table)\b/i

/** Detects "remove X from/in [container]" or "remove X from slides/items/cards" — intra-block, not page-level */
function isContainerScopedRemove(message: string): boolean {
  const lower = message.toLowerCase()
  if (/\b(?:from|in|within|inside)\b/.test(lower) && CONTAINER_BLOCK_TYPES.test(lower)) return true
  if (/\b(?:from|in|within)\s+(?:all\s+)?(?:slides?|items?|cards?|questions?|entries?|rows?|features?)\b/.test(lower)) return true
  return false
}

export const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])
export const intentSchema = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().min(1).nullish(),
  target_block_type: blockTypeEnum.nullish(),
  new_block_type: blockTypeEnum.nullish(),
  position: z.enum(["top", "bottom", "before", "after"]).nullish(),
  anchor_block_ref: z.string().min(1).nullish(),
  patch: z.record(z.string(), z.unknown()).nullish(),
  summary: z.string().min(1).nullish(),
  assumption: z.string().min(1).nullish(),
  complexity: z.enum(["simple", "standard"]).nullish()
})
export type ParsedIntent = z.infer<typeof intentSchema>

/** Returns true when an add-block message carries content direction beyond the block type name. */
function hasContentDirective(message: string): boolean {
  const lower = message.toLowerCase()
  // Phrases that signal the user wants specific content, not just a default block
  return /\b(about|featuring|directing|promoting|highlighting|explaining|describing|marketing|showcasing|illustrating|linking to|that\s+(links?|points?|directs?|promotes?|describes?|shows?|explains?))\b/i.test(lower)
    || /\bfor\b.*\b(audience|users?|visitors?|customers?|readers?)\b/i.test(lower)
    || /\bwith\b.*\b(content|text|copy|images?|questions?|items?|cards?|testimonials?|features?)\b/i.test(lower)
    || /\b(proper|real|good|relevant|meaningful|appropriate|custom|tailored|compelling|engaging)\b/i.test(lower)
}

function isHeroLayoutRequest(message: string) {
  const lower = message.toLowerCase()
  if (!/\b(hero|banner)\b/.test(lower)) return false
  const mentionsVisual = /\b(image|photo|picture|text|copy|content)\b/.test(lower)
  const mentionsSide = /\b(left|right|left-side|right-side)\b/.test(lower)
  const mentionsSwap = /\b(swap|flip|reverse)\b/.test(lower) && /\b(image|photo|picture)\b/.test(lower) && /\b(text|copy|content)\b/.test(lower)
  return (mentionsVisual && mentionsSide) || mentionsSwap
}

function hasQuotedConstraintOnlyText(message: string) {
  if (!quotedText(message)) return false
  return (
    /\b(?:avoid|without|exclude|ban|forbid|never use|do not use|don't use)\b[^.\n]{0,140}["'][^"']+["']/i.test(message) ||
    /\b(?:avoid|without|exclude)\b[^.\n]{0,140}\b(?:cliche|cliches|buzzword|buzzwords)\b[^.\n]{0,140}["'][^"']+["']/i.test(message)
  )
}

function hasQuotedReplacementDirective(message: string) {
  return /\b(?:set|change|update|edit|replace|rewrite|reword|rephrase)\b[^.\n]{0,160}\b(?:to|as|with)\b[^.\n]{0,40}["'][^"']+["']/i.test(message)
}

function inferActionFromMessage(message: string): ParsedIntent["action"] | null {
  const lower = message.toLowerCase()
  const hasPageCreateCue = Boolean(parseCreatePageRequest(message))
  if (isHeroLayoutRequest(lower)) return "update"
  if (hasPageCreateCue) return "add"

  // Use earliest-verb-position to resolve ambiguity (e.g., "add a delete button" → "add")
  const verbPatterns: Array<{ action: ParsedIntent["action"]; pattern: RegExp }> = [
    { action: "remove", pattern: /\b(remove|delete)\b/ },
    { action: "move", pattern: /\b(move|reorder|re-arrange|rearrange)\b/ },
    { action: "add", pattern: /\b(add|insert|create|include|put)\b/ },
    { action: "update", pattern: /\b(update|change|edit|set|rewrit\w*|reword\w*|rephras\w*|replace|improve|shorten|reduc\w*|trim|cut|polish\w*|refin\w*|refresh\w*|tighten\w*|clarif\w*|rename)\b/ },
  ]
  let earliest: { action: ParsedIntent["action"]; index: number } | null = null
  for (const { action, pattern } of verbPatterns) {
    const match = pattern.exec(lower)
    if (match && (earliest === null || match.index < earliest.index)) {
      earliest = { action, index: match.index }
    }
  }
  if (earliest) return earliest.action

  if (/\bad\b/.test(lower) && inferBlockTypeFromText(lower)) return "add"
  return null
}

function inferPatchFromMessage(args: {
  message: string
  action: ParsedIntent["action"]
  targetBlock?: PageDoc["blocks"][number]
  activeEditablePath?: string
}) {
  const { message, action, targetBlock, activeEditablePath } = args
  if (action !== "update") return undefined

  const heroImagePositionPatch = inferHeroImagePositionPatch(message, targetBlock)
  if (heroImagePositionPatch) return heroImagePositionPatch

  const directPatch = inferSimpleFieldPatchFromMessage(message)
  if (directPatch && Object.keys(directPatch).length > 0) return directPatch

  const quoted = quotedText(message)
  if (!quoted) return undefined

  if (activeEditablePath && /^[a-zA-Z0-9_]+$/.test(activeEditablePath)) {
    return { [activeEditablePath]: quoted }
  }

  const block = targetBlock
  if (!block) return undefined

  const allowedKeys = Object.keys(block.props as Record<string, unknown>)
  if (allowedKeys.length === 0) return undefined
  const hintedKey = inferFieldHintFromMessage(message, allowedKeys)
  if (!hintedKey) return undefined
  return { [hintedKey]: quoted }
}

function inferHeroImagePositionPatch(message: string, targetBlock?: PageDoc["blocks"][number]) {
  if (!targetBlock || targetBlock.type !== "Hero") return null
  const lower = message.toLowerCase()

  const asksSwapImageAndText =
    (/\bswap\b/.test(lower) || /\bflip\b/.test(lower) || /\breverse\b/.test(lower)) &&
    /\b(image|photo|picture)\b/.test(lower) &&
    /\b(text|copy|content)\b/.test(lower)

  if (asksSwapImageAndText) {
    const current = String((targetBlock.props as Record<string, unknown>).imagePosition ?? "right")
    return { imagePosition: current === "left" ? "right" : "left" }
  }

  if (
    /\b(image|photo|picture)\b[\s\w-]*\b(?:on|to)\s+the\s+left\b/.test(lower) ||
    /\b(?:left|left-side)\s+(?:image|photo|picture)\b/.test(lower) ||
    /\b(?:image|photo|picture)\s+(?:left|left-side)\b/.test(lower)
  ) {
    return { imagePosition: "left" as const }
  }
  if (
    /\b(image|photo|picture)\b[\s\w-]*\b(?:on|to)\s+the\s+right\b/.test(lower) ||
    /\b(?:right|right-side)\s+(?:image|photo|picture)\b/.test(lower) ||
    /\b(?:image|photo|picture)\s+(?:right|right-side)\b/.test(lower)
  ) {
    return { imagePosition: "right" as const }
  }

  if (
    /\b(text|copy|content)\b[\s\w-]*\b(?:on|to)\s+the\s+left\b/.test(lower) ||
    /\b(?:left|left-side)\s+(?:text|copy|content)\b/.test(lower) ||
    /\b(?:text|copy|content)\s+(?:left|left-side)\b/.test(lower)
  ) {
    return { imagePosition: "right" as const }
  }
  if (
    /\b(text|copy|content)\b[\s\w-]*\b(?:on|to)\s+the\s+right\b/.test(lower) ||
    /\b(?:right|right-side)\s+(?:text|copy|content)\b/.test(lower) ||
    /\b(?:text|copy|content)\s+(?:right|right-side)\b/.test(lower)
  ) {
    return { imagePosition: "left" as const }
  }

  return null
}

export function inferDeterministicIntent(args: {
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): ParsedIntent | null {
  const raw = stripSiteContextEnvelope(args.message).trim()
  if (!raw) return null

  let action = inferActionFromMessage(raw)
  if (!action) return null

  // "remove all except hero" / "delete everything but CTA" — handle deterministically for remove
  if (action === "remove" && EXCEPT_PATTERN.test(raw)) {
    // If message scopes the remove to a specific container block (e.g. "from slides in Carousel"),
    // this is an intra-block item operation — defer to LLM.
    if (isContainerScopedRemove(raw)) return null

    let keepType = inferBlockTypeFromText(raw)
    // "this one" / "this block" / "the selected" → resolve from activeBlockId
    if (!keepType && args.activeBlockId && THIS_ONE_PATTERN.test(raw)) {
      const activeBlock = args.currentPage.blocks.find((b) => b.id === args.activeBlockId)
      if (activeBlock) keepType = activeBlock.type
    }
    if (keepType && args.currentPage.blocks.some((b) => b.type === keepType)) {
      return {
        action: "remove",
        target_block_type: keepType,
        summary: `Removed all blocks except ${keepType}.`
      }
    }
    return null
  }
  // "add all except ..." — needs LLM
  if (action === "add" && EXCEPT_PATTERN.test(raw)) {
    return null
  }

  // In focused inline-edit mode, "add image/photo" should update the selected image field,
  // not add a new block.
  if (
    action === "add" &&
    typeof args.activeEditablePath === "string" &&
    args.activeEditablePath.trim() === "imageUrl" &&
    /\b(image|photo|picture)\b/i.test(raw)
  ) {
    action = "update"
  }

  const refs = resolveReferencesFromMessage({
    message: raw,
    currentPage: args.currentPage,
    activeBlockId: args.activeBlockId
  })

  let targetBlock = refs.target
    ? args.currentPage.blocks.find((block) => block.id === refs.target?.id) ?? null
    : null
  if (!targetBlock && args.activeBlockId) {
    targetBlock = args.currentPage.blocks.find((block) => block.id === args.activeBlockId) ?? null
  }

  const inferred: ParsedIntent = { action }

  if (targetBlock) {
    inferred.target_block_ref = targetBlock.id
    inferred.target_block_type = targetBlock.type
  } else {
    const typeFromMessage = inferBlockTypeFromText(raw)
    if (typeFromMessage) inferred.target_block_type = typeFromMessage
    if (typeFromMessage) {
      const byType = args.currentPage.blocks.filter((block) => block.type === typeFromMessage)
      if (byType.length === 1) {
        targetBlock = byType[0] ?? null
        if (targetBlock) inferred.target_block_ref = targetBlock.id
      }
    }
  }

  if (action === "add") {
    const inferredAddType =
      inferAddedBlockTypeFromMessage(raw) ??
      inferBlockTypeFromText(raw) ??
      targetBlock?.type
    if (inferredAddType) inferred.new_block_type = inferredAddType
  }

  if (action === "move" || action === "add") {
    const lower = raw.toLowerCase()
    if (/\b(top|first|start|beginning)\b/.test(lower)) inferred.position = "top"
    else if (/\b(bottom|last|end)\b/.test(lower)) inferred.position = "bottom"
    else if (/\b(before|above)\b/.test(lower)) inferred.position = "before"
    else if (/\b(after|below|under)\b/.test(lower)) inferred.position = "after"

    if (refs.anchor?.id) inferred.anchor_block_ref = refs.anchor.id
  }

  const patch = inferPatchFromMessage({
    message: raw,
    action,
    targetBlock: targetBlock ?? undefined,
    activeEditablePath: args.activeEditablePath
  })
  if (patch && Object.keys(patch).length > 0) inferred.patch = patch

  return inferred
}

/**
 * Returns true when the message mentions a specific block type or block-synonymous
 * term, indicating the user is talking about a block — not about the page itself.
 * Used to guard page-level operations from misclassifying block-level requests.
 *
 * Strips noise that causes false positives:
 * - Text after "this/the page" (page name refs like "move this page before Pricing")
 * - Route slugs ("/pricing", "/about-us") — these are page refs, not block types
 */
function messageRefersToBlock(message: string, activeBlockId?: string): boolean {
  // When the message explicitly says "this/the page", "this" refers to the page, not the selected block
  if (activeBlockId && /\b(this|the|current)\s+page\b/i.test(message)) return false
  if (activeBlockId) return true
  // Strip text after "this/the/current page" (page name references)
  // and strip route slugs (/pricing, /about) that could false-match block keywords
  const cleaned = message
    .replace(/\b(?:this|the|current)\s+page\b.*/i, "")
    .replace(/\/[a-z0-9_-]+/gi, "")
  if (inferBlockTypeFromText(cleaned)) return true
  // "the/this section", "a component", "the block" — block-synonymous terms with article
  if (/\b(?:the|this|a|that)\s+(?:section|component|block|element|widget)\b/i.test(cleaned)) return true
  return false
}

/**
 * Detects "move (this) page before/after X" — page nav move requests.
 * Matches both route-based ("move page after /pricing") and natural language
 * ("move this page before About us") anchor references.
 * Requires "move" directly adjacent to "this/the/current page" to avoid matching
 * block positioning phrases like "move CTA to the top of the page".
 */
function isNavMoveRequest(message: string) {
  const lower = message.toLowerCase()
  const movesThisPage = /\bmove\s+(?:this|the|current)\s+page\b/.test(lower)
  const hasPlacement = /\b(before|after|above|below|first|last|top|bottom|start|end|beginning)\b/.test(lower)
  return movesThisPage && hasPlacement
}

/**
 * Resolves a natural language page name (e.g. "About us") to a slug by matching
 * against page titles in the session draft. Returns undefined if no match.
 */
function resolvePageSlugByTitle(sessionDraft: Map<string, PageDoc>, name: string): string | undefined {
  const lower = name.toLowerCase().trim()
  if (!lower) return undefined
  for (const [slug, page] of sessionDraft) {
    if (page.title.toLowerCase() === lower) return slug
  }
  // Fuzzy: check if name is contained in title or vice versa
  for (const [slug, page] of sessionDraft) {
    const titleLower = page.title.toLowerCase()
    if (titleLower.includes(lower) || lower.includes(titleLower)) return slug
  }
  return undefined
}

/**
 * Returns true only when UI context makes the intent completely unambiguous,
 * so the deterministic planner can handle it without an LLM call.
 */
export function isHighConfidenceDeterministicCase(args: {
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): boolean {
  const raw = stripSiteContextEnvelope(args.message).trim()
  if (!raw) return false

  // Case 1: Inline edit — user clicked a field, typed a quoted value
  if (args.activeBlockId && args.activeEditablePath && quotedText(raw)) return true

  // Case 2: Inline list append — "add another item" with block selected
  if (args.activeBlockId) {
    const block = args.currentPage.blocks.find(b => b.id === args.activeBlockId)
    if (block && /\b(add|insert)\b/i.test(raw) && /\b(another|more|new)\b/i.test(raw)) {
      if (buildListAppendPatch(block, raw)) return true
    }
  }

  // Case 3: Simple add/remove with clear block type — no LLM needed
  // Bail out for compound requests ("remove X and add Y") — these need the LLM
  const hasCompoundAction = /\b(remove|delete|clear)\b.+\band\b.+\b(add|insert|create)\b/i.test(raw)
    || /\b(add|insert|create)\b.+\band\b.+\b(remove|delete|clear)\b/i.test(raw)
  if (hasCompoundAction) return false
  const hasExceptionModifier = EXCEPT_PATTERN.test(raw)
  if (hasExceptionModifier) {
    // "remove all except X" can be handled deterministically when X resolves to a block type on the page
    const action = inferActionFromMessage(raw)
    if (action === "remove") {
      if (isContainerScopedRemove(raw)) return false  // intra-block item op — defer to LLM
      let keepType = inferBlockTypeFromText(raw)
      if (!keepType && args.activeBlockId && THIS_ONE_PATTERN.test(raw)) {
        const activeBlock = args.currentPage.blocks.find((b) => b.id === args.activeBlockId)
        if (activeBlock) keepType = activeBlock.type
      }
      if (keepType && args.currentPage.blocks.some((b) => b.type === keepType)) return true
    }
    return false
  }
  const action = inferActionFromMessage(raw)
  // Case: create_page — "create a new /about page", "create a new test page"
  // Defer to LLM when user wants content generation (topic + block types enumerated)
  if (action === "add" && parseCreatePageRequest(raw) && !requestsContentGeneration(raw)) return true
  // "add X to each/every card" = bulk item update — needs LLM for content generation
  if (action === "add" && /\b(each|every)\b/i.test(raw)) return false
  // Counted multi-block add without enough named types → needs LLM for content generation
  if (action === "add" && isBatchAddRequest(raw) && extractMentionedBlockTypes(raw).length < 2) return false
  // Case: page rename — "rename page to Our community", "rename this page to /plans"
  if (action === "update" && isPageRouteRenameRequest(raw)) return true
  // Case: page nav move — "move this page before About us", "move page after /pricing"
  // Guard: if message mentions a block type, it's a block move, not a nav move
  if (action === "move" && isNavMoveRequest(raw) && !messageRefersToBlock(raw, args.activeBlockId)) return true
  // Case: page-level delete — "delete this page", "remove the page"
  if (action === "remove" && /\b(delete|remove)\b.*\bpage\b/i.test(raw) && !messageRefersToBlock(raw, args.activeBlockId)) return true
  const removeType = inferBlockTypeFromText(raw)
  if (action === "remove" && removeType) {
    if (args.currentPage.blocks.filter((b) => b.type === removeType).length > 1) return false
    return true
  }
  if (action === "remove" && args.activeBlockId && /\b(this|selected|it)\b/i.test(raw)) return true
  // "add CTA directing to recipes" = needs LLM for content-aware props
  if (action === "add" && inferBlockTypeFromText(raw) && hasContentDirective(raw)) return false
  // Defer to LLM when topic + multiple block types are enumerated (needs content generation)
  if (action === "add" && inferBlockTypeFromText(raw) && !requestsContentGeneration(raw)) return true

  // Case 4: Simple update with clear block type reference and quoted value
  if (action === "update" && inferBlockTypeFromText(raw) && quotedText(raw)) {
    if (hasQuotedConstraintOnlyText(raw)) return false
    if (isRewriteRequest(raw) && !hasQuotedReplacementDirective(raw)) return false
    return true
  }

  return false
}

/**
 * Splits a compound message ("remove the hero and add a CTA") into sub-parts
 * at conjunction boundaries, but only when the parts contain verbs from
 * different action categories (add vs remove, etc.).
 *
 * Returns null when the message is not a decomposable compound request.
 */
function splitCompoundMessage(raw: string): [string, string] | null {
  // Bail when 3+ distinct action verbs are present — too complex for 2-way split
  const lower = raw.toLowerCase()
  const verbCategories = [
    /\b(?:add|insert|create|include)\b/,
    /\b(?:remove|delete|clear)\b/,
    /\b(?:move|reorder|rearrange)\b/,
    /\b(?:update|change|edit|set|replace)\b/,
  ]
  const matchedCategories = verbCategories.filter((p) => p.test(lower)).length
  if (matchedCategories >= 3) return null

  // Only split when two different action-category verbs are connected by a conjunction.
  // Pattern: <verb-group-A> ... <and|then|,> ... <verb-group-B>
  const addVerbs = String.raw`(?:add|insert|create|include)`
  const removeVerbs = String.raw`(?:remove|delete|clear)`
  const conjunction = String.raw`(?:\s+and\s+|\s+then\s+|\s*,\s*(?:and\s+)?(?:then\s+)?)`

  // Try add...conjunction...remove
  const arPattern = new RegExp(
    String.raw`(.*\b${addVerbs}\b[^,]*?)${conjunction}(\b${removeVerbs}\b.*)`,
    "i"
  )
  const arMatch = raw.match(arPattern)
  if (arMatch?.[1] && arMatch?.[2]) return [arMatch[1].trim(), arMatch[2].trim()]

  // Try remove...conjunction...add
  const raPattern = new RegExp(
    String.raw`(.*\b${removeVerbs}\b[^,]*?)${conjunction}(\b${addVerbs}\b.*)`,
    "i"
  )
  const raMatch = raw.match(raPattern)
  if (raMatch?.[1] && raMatch?.[2]) return [raMatch[1].trim(), raMatch[2].trim()]

  // Try move...conjunction...add/remove
  const moveVerbs = String.raw`(?:move|reorder|rearrange)`
  const updateVerbs = String.raw`(?:update|change|edit|set|replace)`
  const pairs: Array<[string, string]> = [
    [moveVerbs, addVerbs],
    [moveVerbs, removeVerbs],
    [addVerbs, updateVerbs],
    [removeVerbs, updateVerbs],
    [updateVerbs, addVerbs],
    [updateVerbs, removeVerbs],
  ]
  for (const [a, b] of pairs) {
    const pattern = new RegExp(
      String.raw`(.*\b${a}\b[^,]*?)${conjunction}(\b${b}\b.*)`,
      "i"
    )
    const match = raw.match(pattern)
    if (match?.[1] && match?.[2]) return [match[1].trim(), match[2].trim()]
  }

  return null
}

/**
 * Attempts to handle a compound message ("remove the hero and add a CTA")
 * by decomposing it into sub-intents and running each through the
 * deterministic planner. Returns null if any sub-intent can't be handled
 * deterministically.
 */
export function tryCompoundDeterministicPlan(args: {
  session: string
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): EditPlan | null {
  const raw = stripSiteContextEnvelope(args.message).trim()
  if (!raw) return null

  const parts = splitCompoundMessage(raw)
  if (!parts) return null

  const [firstMsg, secondMsg] = parts

  // Check both parts individually for high-confidence
  for (const msg of [firstMsg, secondMsg]) {
    if (!isHighConfidenceDeterministicCase({
      message: msg,
      currentPage: args.currentPage,
      activeBlockId: args.activeBlockId,
      activeEditablePath: args.activeEditablePath
    })) return null
  }

  // Build intent + plan for first part
  const firstIntent = inferDeterministicIntent({
    message: firstMsg,
    currentPage: args.currentPage,
    activeBlockId: args.activeBlockId,
    activeEditablePath: args.activeEditablePath
  })
  if (!firstIntent) return null

  const firstPlan = compileDeterministicPlan({
    session: args.session,
    intent: firstIntent,
    message: firstMsg,
    slug: args.slug,
    currentPage: args.currentPage,
    activeBlockId: args.activeBlockId,
    activeEditablePath: args.activeEditablePath
  })
  if (!firstPlan || firstPlan.intent !== "edit_plan" || firstPlan.ops.length === 0) return null

  // Apply first plan's ops to a cloned page so second plan sees updated state
  // (e.g., removed blocks are no longer visible, added blocks can be referenced)
  let updatedPage = args.currentPage
  for (const op of firstPlan.ops) {
    if (op.op === "remove_block") {
      updatedPage = { ...updatedPage, blocks: updatedPage.blocks.filter((b) => b.id !== op.blockId) }
    } else if (op.op === "add_block") {
      updatedPage = { ...updatedPage, blocks: [...updatedPage.blocks, op.block] }
    }
  }

  // Build intent + plan for second part
  const secondIntent = inferDeterministicIntent({
    message: secondMsg,
    currentPage: updatedPage,
    activeBlockId: args.activeBlockId,
    activeEditablePath: args.activeEditablePath
  })
  if (!secondIntent) return null

  const secondPlan = compileDeterministicPlan({
    session: args.session,
    intent: secondIntent,
    message: secondMsg,
    slug: args.slug,
    currentPage: updatedPage,
    activeBlockId: args.activeBlockId,
    activeEditablePath: args.activeEditablePath
  })
  if (!secondPlan || secondPlan.intent !== "edit_plan" || secondPlan.ops.length === 0) return null

  // Merge: removes first (so IDs are valid), then adds
  const removeOps = [...firstPlan.ops, ...secondPlan.ops].filter(op => op.op === "remove_block" || op.op === "remove_page")
  const otherOps = [...firstPlan.ops, ...secondPlan.ops].filter(op => op.op !== "remove_block" && op.op !== "remove_page")

  return {
    intent: "edit_plan",
    summary_for_user: [firstPlan.summary_for_user, secondPlan.summary_for_user].join(" "),
    change_log: [...firstPlan.change_log, ...secondPlan.change_log],
    ops: [...removeOps, ...otherOps]
  }
}

export function compileDeterministicPlan(args: {
  session: string
  intent: ParsedIntent
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
  locale?: string
}): EditPlan | null {
  const { session, intent, message, slug, currentPage, activeBlockId, activeEditablePath } = args
  const cleanMessage = stripSiteContextEnvelope(message)
  const lowerMessage = message.toLowerCase()
  const routeMentions = extractRouteMentions(cleanMessage)
  const assumptions: string[] = []
  if (intent.assumption) assumptions.push(intent.assumption)
  const hasStructuralVerb = /\b(move|reorder|re-arrange|rearrange|add|remove|delete|create|duplicate|rename)\b/.test(lowerMessage)

  if (
    process.env.OPENAI_API_KEY &&
    (intent.action === "update" || intent.action === "clarify") &&
    !hasStructuralVerb &&
    isRewriteRequest(message) &&
    (!hasQuotedReplacementDirective(message) || hasQuotedConstraintOnlyText(message))
  ) return null

  const hasConditionalQualifier = /\bif\s+(required|needed|necessary)\b/.test(lowerMessage)
  const asksSectionReorder =
    /\b(reorder|re-order|rearrange|re-organize|reorganize)\b/.test(lowerMessage) &&
    /\b(section|sections|block|blocks|content|layout|flow|readability)\b/.test(lowerMessage)
  const hasExplicitPlacementCue = /\b(top|bottom|first|last|before|after|above|below|under|between)\b/.test(lowerMessage)
  const hasExplicitBlockMentionInMessage =
    /\bb_[a-z0-9_]+\b/.test(lowerMessage) ||
    /\b(hero|feature grid|features|testimonials?|faq|cta|card grid|cards?|rich[\s-]?text)\b/.test(lowerMessage)

  const selectedBlock = activeBlockId ? currentPage.blocks.find((b) => b.id === activeBlockId) ?? null : null
  const secondaryButtonMentioned =
    lowerMessage.includes("secondary cta") ||
    lowerMessage.includes("secondary button") ||
    lowerMessage.includes("second cta") ||
    lowerMessage.includes("second button") ||
    /sec\w*nd\w*ry\s+(cta|button)/.test(lowerMessage)
  const asksSecondaryCtaAdd =
    secondaryButtonMentioned &&
    (lowerMessage.includes("add") || lowerMessage.includes("create") || lowerMessage.includes("insert") || lowerMessage.includes("include"))

  const asksPageRename = isPageRouteRenameRequest(message)
  if ((intent.action === "update" || intent.action === "move" || intent.action === "clarify") && asksPageRename) {
    const mentionsCurrentPage = /\b(this|current|the)\s+page\b/.test(lowerMessage)
    let fromSlug = routeMentions[0] ?? slug
    let toSlug = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
    if (!toSlug && routeMentions.length === 1 && mentionsCurrentPage) {
      toSlug = routeMentions[0]
      fromSlug = slug
    }
    // Extract natural language name after "to" when no route mentions resolve
    let newTitle: string | undefined
    if (!toSlug || toSlug === fromSlug) {
      // Strip clarification history and site context before extracting the target name
      const msgForRename = message.replace(/\nClarification from user:[\s\S]*/i, "").replace(/\s*\[site context\][\s\S]*$/i, "").trim()
      const nameMatch = msgForRename.match(/\brename\b.*\bpage\b.*?\bto\s+(.+)$/i)
        ?? msgForRename.match(/\brename\b.*?\bto\s+(.+)$/i)
      if (nameMatch) {
        const rawName = nameMatch[1].replace(/[.!?]+$/, "").trim()
        if (rawName) {
          const seed = toSeedSlug(rawName)
          if (seed) {
            toSlug = `/${seed}`
            fromSlug = slug
            newTitle = rawName.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ")
          }
        }
      }
    }
    if (!toSlug || toSlug === fromSlug) {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "rename.needsPath"),
        change_log: assumptions,
        ops: []
      }
    }
    const renameOp: Operation = { op: "rename_page", pageSlug: fromSlug, newPageSlug: toSlug, ...(newTitle ? { newTitle } : {}) }
    return {
      intent: "edit_plan",
      summary_for_user: st(args.locale, "rename.done", { from: fromSlug, to: toSlug }),
      change_log: [...assumptions, `Renamed page ${fromSlug} -> ${toSlug}.`],
      ops: [renameOp]
    }
  }

  const asksPageDelete = /\b(delete|remove)\b.*\bpage\b/.test(lowerMessage) && !messageRefersToBlock(cleanMessage, args.activeBlockId)
  if ((intent.action === "remove" || intent.action === "clarify") && asksPageDelete) {
    const targetSlug = routeMentions[0] ?? slug
    if (targetSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "delete.homeBlocked"),
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: st(args.locale, "delete.done", { slug: targetSlug }),
      change_log: [...assumptions, `Removed page ${targetSlug}.`],
      ops: [{ op: "remove_page", pageSlug: targetSlug }]
    }
  }

  const requestedCreateSlug = parseCreatePageRequest(message)
  // When the user mentions "template", skip deterministic page creation
  // and let the LLM planner use the template definitions from site context.
  const mentionsTemplate = /\btemplate\b/i.test(cleanMessage)
  if ((intent.action === "add" || intent.action === "clarify" || intent.action === "update") && requestedCreateSlug) {
    if (mentionsTemplate) return null // defer to LLM planner
    const createPlan = buildCreatePagePlan({ session, requestedSlug: requestedCreateSlug, assumptions, userMessage: message })
    if (createPlan) return createPlan
  }

  const hasNavContext = /\b(nav|navigation|menu|first|last|position)\b/.test(lowerMessage) || routeMentions.length >= 2
  const asksNavMove =
    !messageRefersToBlock(cleanMessage, args.activeBlockId) && (
      /\b(nav|navigation|menu|tabs?|tab order|page order)\b/.test(lowerMessage) ||
      /\bmove\b.*\btab\b/.test(lowerMessage) ||
      (/\bmove\b.*\bpage\b/.test(lowerMessage) && hasNavContext) ||
      /\breorder\b.*\b(page|nav|menu|tabs?)\b/.test(lowerMessage) ||
      isNavMoveRequest(cleanMessage)
    )
  if ((intent.action === "move" || intent.action === "clarify") && asksNavMove) {
    const sessionDraft = getSessionDraft(session)
    const slugsRaw = Array.from(sessionDraft.keys())
    const ordered = slugsRaw.includes("/") ? ["/", ...slugsRaw.filter((route) => route !== "/")] : slugsRaw
    const movedSlug = routeMentions[0] ?? slug
    if (!ordered.includes(movedSlug)) {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "move.notFound", { slug: movedSlug }),
        change_log: assumptions,
        ops: []
      }
    }
    if (movedSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "move.homeFixed"),
        change_log: assumptions,
        ops: []
      }
    }

    // Extract anchor page name from natural language when no route mentions available
    const resolveAnchorSlug = (): string | undefined => {
      if (routeMentions.length >= 2) return routeMentions[1]
      // "move page before About us" → extract "About us"
      const anchorMatch = cleanMessage.match(/\b(?:before|after|above|below|under)\s+(.+)$/i)
      if (anchorMatch) {
        const name = anchorMatch[1].replace(/\s*\[site context\][\s\S]*$/i, "").replace(/[.!?]+$/, "").trim()
        return resolvePageSlugByTitle(sessionDraft, name)
      }
      return undefined
    }

    let afterPageSlug: string | undefined
    if (/\b(top|first|start|beginning)\b/.test(lowerMessage)) {
      afterPageSlug = undefined
    } else if (/\b(bottom|last|end)\b/.test(lowerMessage)) {
      const tail = [...ordered].reverse().find((route) => route !== movedSlug)
      afterPageSlug = tail === "/" ? "/" : tail
    } else if (/\b(after|below|under)\b/.test(lowerMessage)) {
      const anchor = resolveAnchorSlug()
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "move.specifyWhere"),
          change_log: assumptions,
          ops: []
        }
      }
      afterPageSlug = anchor
    } else if (/\b(before|above)\b/.test(lowerMessage)) {
      const anchor = resolveAnchorSlug()
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "move.specifyWhere"),
          change_log: assumptions,
          ops: []
        }
      }
      if (anchor === "/") afterPageSlug = undefined
      else {
        const index = ordered.findIndex((route) => route === anchor)
        if (index === -1) {
          return {
            intent: "needs_clarification",
            summary_for_user: st(args.locale, "move.anchorNotFound", { slug: anchor }),
            change_log: assumptions,
            ops: []
          }
        }
        const previous = ordered.slice(0, index).reverse().find((route) => route !== movedSlug)
        afterPageSlug = previous === "/" ? "/" : previous
      }
    } else if (routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "move.specifyWhere"),
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user:
        afterPageSlug === undefined
          ? `Moved ${movedSlug} to the first nav position (after Home).`
          : `Moved ${movedSlug} after ${afterPageSlug}.`,
      change_log: [...assumptions, `Reordered nav: ${movedSlug}`],
      ops: [{ op: "move_page", pageSlug: movedSlug, afterPageSlug }]
    }
  }

  const audiences = extractAudienceTargets(message)
  const audience = audiences[0]
  const asksAudienceCreatePage =
    audiences.length > 0 &&
    /\b(create|generate|build|make|draft)\b/.test(lowerMessage) &&
    /\b(pages?|landing pages?)\b/.test(lowerMessage)
  if (asksAudienceCreatePage && audience) {
    if (process.env.OPENAI_API_KEY) return null
    const now = new Date().toISOString()
    const reservedSlugs = new Set(getSessionDraft(session).keys())
    const allocateSlug = (requested: string) => {
      let candidate = requested
      if (!reservedSlugs.has(candidate)) {
        reservedSlugs.add(candidate)
        return candidate
      }
      let idx = 2
      while (reservedSlugs.has(`${requested}-${idx}`)) idx += 1
      candidate = `${requested}-${idx}`
      reservedSlugs.add(candidate)
      return candidate
    }
    const pages = audiences.map((aud, index) => {
      const seed = toSeedSlug(aud) || `audience-${index + 1}`
      const requestedSlug = routeMentions[index] ?? `/for-${seed}`
      const normalizedRequested = normalizeRouteCandidate(requestedSlug) ?? `/for-${seed}`
      const newSlug = allocateSlug(normalizedRequested)
      const label = titleCaseWords(aud)
      const page: PageDoc = {
        id: `p_for_${seed}`,
        slug: newSlug,
        title: `For ${label}`,
        updatedAt: now,
        blocks: [
          {
            id: `b_hero_${seed}`,
            type: "Hero",
            props: {
              heading: `Built for ${label}`,
              subheading: `Everything on this page is tailored for ${aud}.`,
              ctaText: "Get Started",
              ctaHref: "/",
              imageUrl: IMAGE_PLACEHOLDER,
              imageAlt: `Audience-focused hero image for ${label}`
            }
          },
          {
            id: `b_features_${seed}`,
            type: "FeatureGrid",
            props: {
              title: `Why ${label} choose this`,
              features: [
                { title: "Relevant messaging", description: `Copy aligned to ${aud} needs and language.` },
                { title: "Clear outcomes", description: "Benefits are framed around practical results." },
                { title: "Focused next step", description: "CTA is tuned for this audience journey." }
              ]
            }
          },
          {
            id: `b_faq_${seed}`,
            type: "FAQAccordion",
            props: {
              title: `FAQ for ${label}`,
              items: [
                { q: `Is this suitable for ${aud}?`, a: `Yes, this page is tailored for ${aud}.` },
                { q: "How quickly can I start?", a: "Most visitors can get started in minutes." },
                { q: "Can I customize later?", a: "Yes, content and sections can be updated anytime." }
              ]
            }
          },
          {
            id: `b_cta_${seed}`,
            type: "CTA",
            props: {
              title: `Start with a plan for ${label}`,
              description: "Take the next step with content designed for your audience.",
              ctaText: "Start now",
              ctaHref: "/"
            }
          }
        ]
      }
      return { page, audience: aud }
    })
    const createdAudienceLabels = pages.map((entry) => entry.audience)
    const summaryAudienceList = createdAudienceLabels.join(", ")
    return {
      intent: "edit_plan",
      summary_for_user:
        pages.length === 1
          ? `Created a new page tailored for ${audience}.`
          : `Created ${pages.length} new pages tailored for ${summaryAudienceList}.`,
      change_log: [
        ...assumptions,
        ...pages.map((entry) => `Created page ${entry.page.slug} for audience: ${entry.audience}.`)
      ],
      ops: pages.map((entry) => ({ op: "create_page", page: entry.page } satisfies Operation))
    }
  }

  const asksAudienceRetarget =
    Boolean(audience) &&
    !asksAudienceCreatePage &&
    (/\bfor\b/.test(lowerMessage) || /\baudience\b/.test(lowerMessage) || /\btarget\b/.test(lowerMessage))
  if (asksAudienceRetarget && audience) {
    const targets = selectedBlock
      ? [selectedBlock]
      : currentPage.blocks.filter((block) => block.type === "Hero" || block.type === "CTA" || block.type === "RichText").slice(0, 3)
    if (process.env.OPENAI_API_KEY && !selectedBlock) return null
    const ops: Operation[] = []
    for (const block of targets) {
      const patch = audiencePatchForBlock(block, audience)
      if (Object.keys(patch).length === 0) continue
      ops.push({ op: "update_props", pageSlug: slug, blockId: block.id, patch })
    }
    if (ops.length > 0) {
      return {
        intent: "edit_plan",
        summary_for_user: st(args.locale, "audience.done", { audience }),
        change_log: [...assumptions, `Retargeted copy for audience: ${audience}.`],
        ops
      }
    }
  }

  if (intent.action === "move" && hasConditionalQualifier && asksSectionReorder && !hasExplicitPlacementCue && !hasExplicitBlockMentionInMessage) {
    return {
      intent: "needs_clarification",
      summary_for_user: st(args.locale, "reorder.specify"),
      change_log: [...assumptions, "Skipped ambiguous conditional reorder request without explicit section or placement."],
      ops: []
    }
  }

  if (
    selectedBlock?.type === "Hero" &&
    asksSecondaryCtaAdd &&
    (intent.action === "add" || intent.action === "clarify" || intent.action === "update")
  ) {
    const heroProps = selectedBlock.props as Record<string, unknown>
    const existingText = typeof heroProps.secondaryCtaText === "string" ? heroProps.secondaryCtaText.trim() : ""
    const existingHref = typeof heroProps.secondaryCtaHref === "string" ? heroProps.secondaryCtaHref.trim() : ""
    const quoted = quotedText(message)
    const patch: Record<string, unknown> = {
      secondaryCtaText: quoted ?? (existingText.length > 0 ? existingText : "Learn more"),
      secondaryCtaHref: existingHref.length > 0 ? existingHref : "/"
    }

    return {
      intent: "edit_plan",
      summary_for_user: st(args.locale, "hero.secondaryCta"),
      change_log: [...assumptions, `Updated ${selectedBlock.id}: secondaryCtaText, secondaryCtaHref`],
      ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
    }
  }

  // "each/every/all" signals a bulk update across items — needs LLM, not inline append
  const asksBulkUpdate = /\b(each|every|all)\b/.test(lowerMessage)
  const asksInlineAdd =
    !asksBulkUpdate &&
    lowerMessage.includes("add") &&
    (lowerMessage.includes("inside") ||
      lowerMessage.includes("within") ||
      lowerMessage.includes("current") ||
      lowerMessage.includes("this one") ||
      lowerMessage.includes("more") ||
      lowerMessage.includes("another"))

  if ((intent.action === "add" || intent.action === "clarify") && asksInlineAdd) {
    let inlineTarget = selectedBlock
    if (!inlineTarget) {
      const typeMap: Array<{ test: RegExp; type: BlockType }> = [
        { test: /\btestimonial/, type: "Testimonials" },
        { test: /\b(faq|question)/, type: "FAQAccordion" },
        { test: /\bfeature/, type: "FeatureGrid" },
        { test: /\bcard/, type: "CardGrid" }
      ]
      for (const entry of typeMap) {
        if (entry.test.test(lowerMessage)) {
          const matches = currentPage.blocks.filter((b) => b.type === entry.type)
          if (matches.length === 1) inlineTarget = matches[0]
          break
        }
      }
    }
    if (inlineTarget) {
      const patch = buildListAppendPatch(inlineTarget, message)
      if (patch) {
        return {
          intent: "edit_plan",
          summary_for_user: st(args.locale, "update.done", { type: inlineTarget.type }),
          change_log: [...assumptions, `Added one entry to ${inlineTarget.id}.`],
          ops: [{ op: "update_props", pageSlug: slug, blockId: inlineTarget.id, patch }]
        }
      }
    }
  }

  if (intent.action === "info") {
    // Let the full planner handle info queries — it produces detailed
    // block descriptions via the submit_edit_plan tool.
    return null
  }

  if (intent.action === "clarify" && !activeEditablePath) {
    return {
      intent: "needs_clarification",
      summary_for_user: intent.summary ?? st(args.locale, "update.specify"),
      change_log: assumptions,
      ops: []
    }
  }

  // "remove all except X" — generate remove ops for every block NOT matching the kept type
  if (intent.action === "remove" && EXCEPT_PATTERN.test(cleanMessage)) {
    const keepType = intent.target_block_type
    if (keepType) {
      const toRemove = currentPage.blocks.filter((b) => b.type !== keepType)
      if (toRemove.length === 0) {
        return {
          intent: "edit_plan",
          summary_for_user: st(args.locale, "remove.allAlready", { type: keepType }),
          change_log: assumptions,
          ops: []
        }
      }
      return {
        intent: "edit_plan",
        summary_for_user: intent.summary ?? `Removed all blocks except ${keepType}.`,
        change_log: [
          ...assumptions,
          ...toRemove.map((b) => `Removed ${b.type} (${b.id}).`)
        ],
        ops: toRemove.map((b) => ({ op: "remove_block" as const, pageSlug: slug, blockId: b.id }))
      }
    }
  }

  if (intent.action === "remove") {
    let target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target && !activeBlockId) {
      const inferredType = inferBlockTypeFromText(cleanMessage)
      if (inferredType) {
        const matches = currentPage.blocks.filter((b) => b.type === inferredType)
        if (matches.length === 1) target = matches[0]
      }
    }
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "remove.needsBlock"),
        change_log: assumptions,
        ops: []
      }
    }
    // Detect item-level removal (e.g., "remove the first question from the FAQ")
    // Skip when the user wants to remove image *properties* (e.g. "remove images from cards")
    const asksRemoveImageProps = /\bremove\b.*\b(images?|photos?|pictures?)\b.*\b(from|in|on)\b/i.test(lowerMessage)
    const asksRemoveItem = !asksRemoveImageProps && /\b(question|item|entry|testimonial|card|feature|first|second|third|last)\b/i.test(lowerMessage)
    if (asksRemoveItem) {
      const bProps = target.props as Record<string, unknown> | undefined
      if (bProps) {
        for (const [key, val] of Object.entries(bProps)) {
          if (!Array.isArray(val) || val.length === 0) continue
          // Use ordinalToIndex for consistent ordinal parsing
          const ordMatch = lowerMessage.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/i)
          const parsedIdx = ordMatch ? ordinalToIndex(ordMatch[1]) : 0
          if (parsedIdx === null) {
            return {
              intent: "needs_clarification",
              summary_for_user: st(args.locale, "remove.specifyItem"),
              change_log: assumptions,
              ops: []
            }
          }
          const idx = parsedIdx === -1 ? val.length - 1 : parsedIdx
          if (idx >= val.length) {
            return {
              intent: "needs_clarification",
              summary_for_user: st(args.locale, "remove.outOfRange", { count: String(val.length), type: target.type, index: String(idx + 1) }),
              change_log: assumptions,
              ops: []
            }
          }
          return {
            intent: "edit_plan",
            summary_for_user: intent.summary ?? st(args.locale, "remove.itemDone", { type: target.type }),
            change_log: [...assumptions, `Removed item at index ${idx} from ${target.id}.${key}.`],
            ops: [{ op: "remove_item", pageSlug: slug, blockId: target.id, listKey: key, index: idx }]
          }
        }
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? st(args.locale, "remove.done", { type: target.type }),
      change_log: [...assumptions, `Removed block ${target.id}.`],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: target.id }]
    }
  }

  if (intent.action === "update" || (intent.action === "clarify" && !!activeEditablePath)) {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "update.needsBlock"),
        change_log: assumptions,
        ops: []
      }
    }
    const childPatch = coercePatchForEditablePath(target, activeEditablePath, intent.patch, message)
    const fullPatch = coercePatchForBlock(target, intent.patch)
    const mergedRichTextTranslationPatch = shouldKeepRichTextTitleOnTranslate({
      target,
      activeEditablePath,
      message,
      fullPatch
    })
      ? { ...fullPatch, ...(childPatch?.patch ?? {}) }
      : null
    const patch = mergedRichTextTranslationPatch ?? childPatch?.patch ?? fullPatch
    if (Object.keys(patch).length === 0) {
      const editableFields = userFacingPropNames(target.type, Object.keys(target.props))
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "update.invalidFields", { type: target.type }),
        change_log: [...assumptions, `Editable fields: ${editableFields.join(", ")}`],
        ops: []
      }
    }
    const changedKeys = userFacingPropNames(target.type, Object.keys(patch))
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? st(args.locale, "update.done", { type: target.type }),
      change_log: [
        ...assumptions,
        childPatch
          ? `Updated ${target.id} ${activeEditablePath}: ${changedKeys.join(", ")}`
          : `Updated ${target.id}: ${changedKeys.join(", ")}`
      ],
      ops: [{ op: "update_props", pageSlug: slug, blockId: target.id, patch }]
    }
  }

  if (intent.action === "move") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "move.needsBlock"),
        change_log: assumptions,
        ops: []
      }
    }

    let afterBlockId: string | undefined
    if (intent.position === "top") {
      afterBlockId = undefined
    } else if (intent.position === "bottom") {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "move.anchorBlockNotFound"),
          change_log: assumptions,
          ops: []
        }
      }
      afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "move.anchorBlockBeforeNotFound"),
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) afterBlockId = currentPage.blocks[idx - 1]?.id
      else afterBlockId = undefined
    } else if (message.toLowerCase().includes("bottom") || message.toLowerCase().includes("end")) {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "move.specifyDirection"),
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? st(args.locale, "move.blockDone", { type: target.type }),
      change_log: [...assumptions, `Moved block ${target.id}.`],
      ops: [{ op: "move_block", pageSlug: slug, blockId: target.id, afterBlockId }]
    }
  }

  if (intent.action === "add") {
    // --- Batch add: "add 3 blocks: hero, cardgrid and CTA" ----------------
    if (isBatchAddRequest(message)) {
      const blockTypes = extractMentionedBlockTypes(message)
      if (blockTypes.length >= 2) {
        const ops: Operation[] = []
        const changeLog = [...assumptions]
        // Track blocks as we add them so nextBlockId generates unique IDs
        let pageSnapshot = currentPage
        for (const bt of blockTypes) {
          const blockId = nextBlockId(bt, pageSnapshot)
          const props = defaultPropsForType(bt)
          ops.push({ op: "add_block", pageSlug: slug, block: { id: blockId, type: bt, props } })
          changeLog.push(`Added ${bt} block ${blockId}.`)
          // Update snapshot so the next nextBlockId sees existing IDs
          pageSnapshot = { ...pageSnapshot, blocks: [...pageSnapshot.blocks, { id: blockId, type: bt, props }] }
        }
        return {
          intent: "edit_plan",
          summary_for_user: st(args.locale, "add.multiple", { types: blockTypes.join(", ") }),
          change_log: changeLog,
          ops
        }
      }
    }

    // --- Single add -------------------------------------------------------
    const blockType =
      intent.new_block_type ??
      inferAddedBlockTypeFromMessage(message) ??
      intent.target_block_type ??
      inferBlockTypeFromText(intent.target_block_ref ?? "") ??
      inferBlockTypeFromText(message)
    if (!blockType) {
      // No block type found — check if this is an image replacement request
      // e.g. "add unsplash image", "add a new photo", "add image"
      const isImageRequest = /\b(image|photo|picture)\b/.test(lowerMessage)
      if (isImageRequest) {
        const hero = selectedBlock?.type === "Hero"
          ? selectedBlock
          : currentPage.blocks.find((b) => b.type === "Hero") ?? null
        if (hero) {
          return {
            intent: "edit_plan",
            summary_for_user: st(args.locale, "add.heroImage"),
            change_log: [...assumptions, `Updated ${hero.id}: imageUrl`],
            ops: [{ op: "update_props", pageSlug: slug, blockId: hero.id, patch: { imageUrl: "pending" } }]
          }
        }
      }
      return {
        intent: "needs_clarification",
        summary_for_user: st(args.locale, "add.specifyType", { types: allowedBlockTypes.join(", ") }),
        change_log: assumptions,
        ops: []
      }
    }

    // Check if this is an item-level addition to an existing list block
    const existingOfType = currentPage.blocks.filter((b) => b.type === blockType)
    if (existingOfType.length === 1) {
      const existing = existingOfType[0]!
      const listPatch = buildListAppendPatch(existing, message)
      if (listPatch) {
        return {
          intent: "edit_plan",
          summary_for_user: intent.summary ?? st(args.locale, "add.itemDone", { type: existing.type }),
          change_log: [...assumptions, `Appended item to ${existing.id}.`],
          ops: [{ op: "update_props", pageSlug: slug, blockId: existing.id, patch: listPatch }]
        }
      }
    }

    const blockId = nextBlockId(blockType, currentPage)
    const baseProps = defaultPropsForType(blockType)
    const patch = coercePatchForBlock({ id: blockId, type: blockType, props: baseProps }, intent.patch)
    const props = { ...baseProps, ...patch }

    const addOp: Operation = {
      op: "add_block",
      pageSlug: slug,
      block: { id: blockId, type: blockType, props }
    }

    let extraMoveTop: Operation | null = null
    if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "add.anchorAfterNotFound"),
          change_log: assumptions,
          ops: []
        }
      }
      addOp.afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: st(args.locale, "add.anchorBeforeNotFound"),
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) addOp.afterBlockId = currentPage.blocks[idx - 1]?.id
      else extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "top") {
      extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "bottom" || !intent.position) {
      // no-op: add without anchor appends to bottom in applyOpsAtomically
    }

    const ops: Operation[] = extraMoveTop ? [addOp, extraMoveTop] : [addOp]
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? st(args.locale, "add.done", { type: blockType }),
      change_log: [...assumptions, `Added ${blockType} block ${blockId}.`],
      ops
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Re-exports from split files (preserve public API)
// ---------------------------------------------------------------------------
export {
  extractAudienceTarget,
  extractAudienceTargets,
  titleCaseWords,
  addAudienceSuffix,
  audiencePatchForBlock,
  coercePatchForBlock,
  parseIndexedPath,
  inferSimpleFieldPatchFromMessage,
  isRewriteRequest,
  isTranslationRequest,
  shouldKeepRichTextTitleOnTranslate,
  inferFieldHintFromMessage,
  rewriteFromExisting,
  coercePatchForEditablePath,
  quotedText,
  buildListAppendPatch
} from "./deterministic-planner-patches.js"
export {
  editablePropsFromBlock,
  promptFromPropKey,
  userFacingPropNames,
  ORDINALS,
  humanizeArrayPath,
  childSuggestions,
  clarificationSuggestions,
  postEditSuggestions,
  demoPlanFromMessage,
  titleCaseSentence,
  pageMetaContractSummary,
  blockContractsSummary
} from "./deterministic-planner-suggestions.js"
export {
  nextAvailableSlug,
  createPageBlocks,
  buildCreatePagePlan,
  isPageRouteRenameRequest
} from "./deterministic-planner-pages.js"
export {
  readPathValue,
  resolveImageUrlForAltField,
  fetchImageAsBase64,
  selectedBlockSnapshot,
  arrayPropLengths,
  pageIntentSummary,
  plannerContextPack
} from "./deterministic-planner-context.js"
export {
  inferAddedBlockTypeFromMessage,
  resolveBlockRef,
  ordinalToIndex,
  resolveByDescriptor,
  resolveReferencesFromMessage
} from "./deterministic-planner-refs.js"
