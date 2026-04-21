import { z } from "zod"
import { allowedBlockTypes, type BlockType, type PageDoc } from "@ai-site-editor/shared"
import { parseCreatePageRequest, requestsContentGeneration } from "./intent-helpers.js"
import {
  isBatchAddRequest,
  isFieldContentUpdateRequest,
  stripSiteContextEnvelope,
  extractMentionedBlockTypes
} from "./intent-detection.js"
import { inferBlockTypeFromText } from "./plan-normalizer.js"
import { EXCEPT_PATTERN, THIS_ONE_PATTERN } from "./intent-patterns.js"
import {
  quotedText,
  inferSimpleFieldPatchFromMessage,
  inferFieldHintFromMessage,
  isRewriteRequest,
  buildListAppendPatch
} from "./deterministic-planner-patches.js"
import {
  resolveReferencesFromMessage,
  inferAddedBlockTypeFromMessage
} from "./deterministic-planner-refs.js"
import { isPageRouteRenameRequest } from "./deterministic-planner-pages.js"

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

export function hasQuotedConstraintOnlyText(message: string) {
  if (!quotedText(message)) return false
  return (
    /\b(?:avoid|without|exclude|ban|forbid|never use|do not use|don't use)\b[^.\n]{0,140}["'][^"']+["']/i.test(message) ||
    /\b(?:avoid|without|exclude)\b[^.\n]{0,140}\b(?:cliche|cliches|buzzword|buzzwords)\b[^.\n]{0,140}["'][^"']+["']/i.test(message)
  )
}

export function hasQuotedReplacementDirective(message: string) {
  return /\b(?:set|change|update|edit|replace|rewrite|reword|rephrase)\b[^.\n]{0,160}\b(?:to|as|with)\b[^.\n]{0,40}["'][^"']+["']/i.test(message)
}

export function inferActionFromMessage(message: string): ParsedIntent["action"] | null {
  const lower = message.toLowerCase()
  const hasPageCreateCue = Boolean(parseCreatePageRequest(message))
  if (isHeroLayoutRequest(lower)) return "update"
  if (hasPageCreateCue) return "add"
  // "add X in/to [the Y] heading/subheading/copy/..." → update to a field, not add.
  // Must run before the generic verb-position pass so "add" does not win.
  if (isFieldContentUpdateRequest(message)) return "update"

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
export function messageRefersToBlock(message: string, activeBlockId?: string): boolean {
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
export function isNavMoveRequest(message: string) {
  const lower = message.toLowerCase()
  const movesThisPage = /\bmove\s+(?:this|the|current)\s+page\b/.test(lower)
  const hasPlacement = /\b(before|after|above|below|first|last|top|bottom|start|end|beginning)\b/.test(lower)
  return movesThisPage && hasPlacement
}

/**
 * Resolves a natural language page name (e.g. "About us") to a slug by matching
 * against page titles in the session draft. Returns undefined if no match.
 */
export function resolvePageSlugByTitle(sessionDraft: Map<string, PageDoc>, name: string): string | undefined {
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
  // "add a hero image of X" when Hero already exists = image update, not block add — defer to LLM
  const addBlockType = action === "add" ? inferBlockTypeFromText(raw) : null
  if (action === "add" && addBlockType && /\b(image|photo|picture|icon)\b/i.test(raw) && args.currentPage.blocks.some(b => b.type === addBlockType)) return false
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
