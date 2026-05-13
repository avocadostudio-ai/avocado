import type { BlockType, PageDoc } from "@avocadostudio-ai/shared"
import { inferBlockTypeFromText } from "./plan-normalizer.js"

// ---------------------------------------------------------------------------
// Block type inference from message
// ---------------------------------------------------------------------------

export function inferAddedBlockTypeFromMessage(message: string): BlockType | undefined {
  const normalized = message.toLowerCase()
  const addMatch = normalized.match(/\b(add|create|insert)\b\s+(?:(?:a|an)\b)?\s*([a-z -]+)/)
  if (!addMatch?.[2]) return undefined
  const chunk = addMatch[2]
    .trim()
    .replace(/^(?:new|another)\s+/, "")
  if (chunk.startsWith("card grid") || chunk.startsWith("cardgrid")) return "CardGrid"
  if (chunk.startsWith("card")) return "Card"
  if (chunk.startsWith("feature grid") || chunk.startsWith("featuregrid") || chunk.startsWith("features")) return "FeatureGrid"
  if (chunk.startsWith("testimonial") || chunk.startsWith("social proof") || chunk.startsWith("review") || chunk.startsWith("quote")) return "Testimonials"
  if (chunk.startsWith("faq")) return "FAQAccordion"
  if (chunk.startsWith("two column") || chunk.startsWith("twocolumn") || chunk.startsWith("2 column")) return "TwoColumn"
  if (chunk.startsWith("stats") || chunk.startsWith("statistics") || chunk.startsWith("metrics") || chunk.startsWith("numbers")) return "Stats"
  if (chunk.startsWith("cta")) return "CTA"
  if (chunk.startsWith("hero")) return "Hero"
  if (chunk.startsWith("rich text") || chunk.startsWith("richtext") || chunk.startsWith("rich-text") || chunk.startsWith("prose") || chunk.startsWith("text block") || chunk.startsWith("section") || chunk.startsWith("paragraph") || chunk.startsWith("copy")) return "RichText"
  if (chunk.startsWith("benefit") || chunk.startsWith("advantage")) return "FeatureGrid"
  if (chunk.startsWith("pricing")) return "CardGrid"
  return undefined
}

// ---------------------------------------------------------------------------
// Block reference resolution
// ---------------------------------------------------------------------------

export function resolveBlockRef(args: {
  ref?: string | null
  currentPage: PageDoc
  activeBlockId?: string
  fallbackType?: BlockType | null
}): PageDoc["blocks"][number] | null {
  const { ref, currentPage, activeBlockId, fallbackType } = args
  const blocks = currentPage.blocks
  if (typeof ref === "string" && ref.length > 0) {
    const exact = blocks.find((b) => b.id === ref)
    if (exact) return exact
    const key = ref.toLowerCase().replace(/[\s_-]/g, "")
    if (["selected", "active", "current", "this"].includes(key) && activeBlockId) {
      const selected = blocks.find((b) => b.id === activeBlockId)
      if (selected) return selected
    }
    const byType = inferBlockTypeFromText(key)
    if (byType) {
      const found = blocks.find((b) => b.type === byType)
      if (found) return found
    }
    const contains = blocks.find((b) => b.id.toLowerCase().includes(key))
    if (contains) return contains
    // User named something specific that doesn't exist — don't fall back to selected block
    return null
  }

  if (activeBlockId) {
    const selected = blocks.find((b) => b.id === activeBlockId)
    if (selected) return selected
  }
  if (fallbackType) {
    const found = blocks.find((b) => b.type === fallbackType)
    if (found) return found
  }
  return null
}

export function ordinalToIndex(value: string) {
  const key = value.toLowerCase()
  if (key === "first" || key === "1st") return 0
  if (key === "second" || key === "2nd") return 1
  if (key === "third" || key === "3rd") return 2
  if (key === "fourth" || key === "4th") return 3
  if (key === "fifth" || key === "5th") return 4
  if (key === "last") return -1
  return null
}

export function resolveByDescriptor(args: { descriptor: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { descriptor, currentPage, activeBlockId } = args
  const normalized = descriptor.trim().toLowerCase()
  if (!normalized) return null
  if (["this", "this block", "this section", "selected", "selected block", "current block"].includes(normalized)) {
    if (!activeBlockId) return null
    return currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
  }

  const exact = currentPage.blocks.find((b) => b.id.toLowerCase() === normalized)
  if (exact) return exact

  const type = inferBlockTypeFromText(normalized)
  if (!type) return null
  const typed = currentPage.blocks.filter((b) => b.type === type)
  if (typed.length === 0) return null

  const ord = normalized.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/)?.[1]
  const idx = ord ? ordinalToIndex(ord) : 0
  if (idx === null) return typed[0]
  if (idx === -1) return typed[typed.length - 1]
  return typed[idx] ?? typed[0]
}

export function resolveReferencesFromMessage(args: { message: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { message, currentPage, activeBlockId } = args
  const lower = message.toLowerCase()

  const mentioned = new Map<string, { id: string; type: BlockType; reason: string }>()
  const addMention = (block: PageDoc["blocks"][number] | null, reason: string) => {
    if (!block) return
    if (!mentioned.has(block.id)) mentioned.set(block.id, { id: block.id, type: block.type, reason })
  }

  if (activeBlockId) {
    const selected = currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
    addMention(selected, "active_selection")
  }

  const descriptorMatches = lower.match(
    /\b(first|second|third|fourth|fifth|last)?\s*(hero|feature grid|features|testimonials?|faq|cta|card grid|card)s?\b/g
  )
  for (const match of descriptorMatches ?? []) {
    addMention(resolveByDescriptor({ descriptor: match, currentPage, activeBlockId }), "descriptor_match")
  }

  for (const block of currentPage.blocks) {
    if (lower.includes(block.id.toLowerCase())) addMention(block, "id_match")
  }

  const afterDescriptor = lower.match(/\b(?:after|below|under)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const beforeDescriptor = lower.match(/\b(?:before|above)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const primaryDescriptor = lower.match(/\b(?:update|change|edit|remove|delete|move)\s+([a-z0-9_\-\s]+?)(?:\b(?:to|into|with|after|before|above|below|under)\b|[,.]|$)/)?.[1]?.trim()

  const anchor = resolveByDescriptor({
    descriptor: afterDescriptor ?? beforeDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  const target = resolveByDescriptor({
    descriptor: primaryDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  addMention(anchor, "anchor_match")
  addMention(target, "target_match")

  return {
    target: target ? { id: target.id, type: target.type } : null,
    anchor: anchor ? { id: anchor.id, type: anchor.type } : null,
    mentionedBlocks: Array.from(mentioned.values()).slice(0, 8)
  }
}
