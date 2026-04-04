/**
 * Consolidated intent-pattern registry.
 *
 * All regex/string-array constants used for intent classification live here.
 * Functions that *use* the patterns stay in their original modules — only the
 * pattern definitions are centralised.
 */

import type { BlockType } from "@ai-site-editor/shared"

// ---------------------------------------------------------------------------
// Shared building-block fragments
// ---------------------------------------------------------------------------

/** Matches "block(s)", "component(s)", "section(s)", "element(s)", "widget(s)" */
export const UNIT = String.raw`(?:blocks?|components?|sections?|elements?|widgets?)`

/** Matches "block type(s)", "component type(s)", etc. */
export const UNIT_TYPE = String.raw`(?:block|component|section|element|widget)\s+types?`

// ---------------------------------------------------------------------------
// Block catalog — "what blocks can I add?"
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Batch add — "add all available block types", "scaffold the page"
// ---------------------------------------------------------------------------

export const BATCH_ADD_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\badd\s+(?:all|every|each|the\s+remaining|the\s+rest\s+of(?:\s+the)?)\s+${UNIT}\b`),
  new RegExp(String.raw`\badd\s+(?:all|every|each|the\s+remaining|the\s+rest\s+of(?:\s+the)?)\s+${UNIT_TYPE}\b`),
  /\bscaffold\b/,
  /\bfill\s+(?:out\s+)?(?:the\s+)?page\b/,
  /\badd\s+(?:all|every)\s+(?:available|missing|remaining)\b/,
  new RegExp(String.raw`\b(?:all|every)\s+(?:available|missing|remaining)\s+${UNIT}\b`),
  /\bbuild\s+(?:out|up)\s+(?:the\s+)?(?:whole\s+)?page\b/,
  // "showcasing/featuring all (available) components/blocks" — page creation with all block types
  new RegExp(String.raw`\b(?:showcas\w*|featuring|demonstrat\w*)\s+(?:all\s+)?(?:(?:the\s+)?available\s+)?${UNIT}\b`),
  // "all available componenzs" and similar typos — fuzzy match for "all available" + unit-like word
  /\ball\s+(?:available|existing)\s+\w*(?:componen|block|section|element|widget)\w*\b/,
  // "add more content/sections to this page", "add content to the page"
  /\badd\s+(?:more\s+)?(?:content|sections?)\s+(?:to\s+)?(?:this|the)\s+page\b/,
  // "expand this page", "flesh out this page", "enrich this page"
  /\b(?:expand|flesh\s+out|enrich|grow|extend|bulk\s+up)\s+(?:this|the)\s+page\b/
]

// ---------------------------------------------------------------------------
// Batch update — "populate all components", "update all blocks"
// ---------------------------------------------------------------------------

export const BATCH_UPDATE_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every|each)\s+${UNIT}\b`),
  new RegExp(String.raw`\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every|each)\s+${UNIT_TYPE}\b`),
  new RegExp(String.raw`\b(?:populate|fill\s+in|fill)\s+(?:all|every|each)\s+(?:the\s+)?${UNIT}\b`),
  /\b(?:populate|update|edit|change|rewrite|refresh)\s+(?:all|every)\s+(?:existing\s+)?(?:content|blocks?|components?|sections?)\b/,
  /\bpopulate\s+(?:\w+\s+){0,2}page\b/,
  /\bpopulate\b.{0,60}\bwith\b.{0,30}\bcontent\b/,
  /\b(?:sample|placeholder|demo)\s+content\s+(?:for|to|in|on)\s+(?:all|every|each)\b/,
  new RegExp(String.raw`\b(?:all|every|each)\s+(?:the\s+)?${UNIT}\s+with\s+(?:sample|placeholder|demo|real)\s+content\b`)
]

// ---------------------------------------------------------------------------
// Batch page creation — "create pages for these audiences"
// ---------------------------------------------------------------------------

export const BATCH_PAGE_CREATE_PATTERNS: RegExp[] = [
  /\b(?:create|generate|build|make|draft|add)\b[^.\n]{0,140}\bpages\b/,
  /\b(?:create|generate|build|make|draft)\b[^.\n]{0,140}\bonly\b[^.\n]{0,140}\bpages\b/,
  /\bpages?\s+for\s+(?:these|those|the following|multiple|several)\b/,
  /\bfor\s+.+\b(?:and|,|&)\b.+\bpages?\b/,
  /\bfor\s+.+\b(?:and|,|&)\b.+\b(?:audiences|users?|customers?|buyers?|founders?|teams?|developers?|marketers?|parents?|students?)\b/
]

// ---------------------------------------------------------------------------
// Counted multi-block add — "add 3 blocks", "add two sections"
// ---------------------------------------------------------------------------

export const COUNTED_MULTI_BLOCK_ADD_PATTERN =
  /\b(?:add|insert|include|create|generate|build)\s+(?:\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:\w+[-\s])*)(?:block\w*|component\w*|section\w*|element\w*|widget\w*)\b/

// ---------------------------------------------------------------------------
// Generic add-action verb
// ---------------------------------------------------------------------------

export const ADD_ACTION_PATTERN = /\b(?:add|insert|include|create|generate|build)\b/

// ---------------------------------------------------------------------------
// Block-type keyword lookup — maps natural language to BlockType values
// ---------------------------------------------------------------------------

export const BLOCK_TYPE_KEYWORDS: Array<{ key: string; pattern: RegExp }> = [
  { key: "hero", pattern: /\bhero\b/ },
  { key: "featuregrid", pattern: /\bfeature\s*grid\b|\bfeatures?\b/ },
  { key: "testimonials", pattern: /\btestimonials?\b|\breviews?\b(?!\s+(?:the|this|it|my|our|heading|page|content|copy|text|block|section))|\bsocial proof\b/ },
  { key: "faq", pattern: /\bfaq\b/ },
  { key: "cta", pattern: /\bcta\b|\bcall to action\b/ },
  { key: "cardgrid", pattern: /\bcard\s*grid\b|\bcardgrid\b|\bpricing\b/ },
  { key: "card", pattern: /\bcard\b/ },
  { key: "richtext", pattern: /\brich[\s-]?text\b|\btext block\b|\bparagraph\b|\bcopy\b(?!\s+(?:the|this|it|of|from|to))/ },
  { key: "twocolumn", pattern: /\btwo\s*column\b|\btwocolumn\b|\b2\s*column\b/ },
  { key: "stats", pattern: /\bstats?\b|\bstatistics\b|\bmetrics\b|\bnumbers\b/ },
  { key: "carousel", pattern: /\bcarousel\b|\bslideshow\b|\bslider\b/ },
  { key: "gallery", pattern: /\bgallery\b|\bimage grid\b/ },
  { key: "tabs", pattern: /\btabs?\b|\btabbed\b/ },
  { key: "table", pattern: /\btable\b/ },
  { key: "quote", pattern: /\bblockquote\b/ },
  { key: "video", pattern: /\bvideo\b/ },
  { key: "embed", pattern: /\bembed\b|\biframe\b/ },
  { key: "banner", pattern: /\bbanner\b|\bannouncement\b/ }
]

export const KEYWORD_TO_BLOCK_TYPE: Record<string, BlockType> = {
  hero: "Hero",
  featuregrid: "FeatureGrid",
  testimonials: "Testimonials",
  faq: "FAQAccordion",
  cta: "CTA",
  cardgrid: "CardGrid",
  card: "Card",
  richtext: "RichText",
  twocolumn: "TwoColumn",
  stats: "Stats",
  carousel: "Carousel",
  gallery: "Gallery",
  tabs: "Tabs",
  table: "Table",
  quote: "Quote",
  video: "Video",
  embed: "Embed",
  banner: "Banner"
}

// ---------------------------------------------------------------------------
// "each card", "every feature" — batch op across specific block type items
// ---------------------------------------------------------------------------

export const EACH_BLOCK_TYPE_PATTERN = new RegExp(
  String.raw`\b(?:each|every|all)\s+(?:` +
    BLOCK_TYPE_KEYWORDS.map((entry) => entry.pattern.source).join("|") +
    String.raw`)\b`
)

// ---------------------------------------------------------------------------
// Page-wide rewrite / rebrand — "refocus this page on X"
// ---------------------------------------------------------------------------

export const PAGE_WIDE_REWRITE_PATTERNS: RegExp[] = [
  /\b(?:refocus|rebrand|retheme|overhaul|redesign|transform)\s+(?:this|the)\s+page\b/,
  /\brewrite\s+(?:all|the|this)\s+(?:page|content)\b/,
  /\bredo\s+(?:this|the)\s+(?:whole\s+|entire\s+)?page\b/,
  /\b(?:update|change)\s+(?:this|the)\s+(?:whole|entire)\s+page\b/,
  // Structural audit requests — "review heading hierarchy", "fix heading structure", "review Grapefruits page heading tag hierarchy"
  /\b(?:review|audit|fix|check)\b[\s\w]*\bheadings?\s*(?:tags?\s*)?(?:hierarchy|structure|levels?|order)\b/,
]

// ---------------------------------------------------------------------------
// Batch reorder / rearrange — "reorder blocks", "rearrange sections"
// ---------------------------------------------------------------------------

export const BATCH_REORDER_PATTERNS: RegExp[] = [
  /\b(?:reorder|re-order|rearrange|reorganize|re-organize|sort|shuffle)\s+(?:the\s+|all\s+)?(?:blocks?|sections?|components?|elements?)\b/,
  /\b(?:reorder|re-order|rearrange|reorganize|re-organize|sort|shuffle)\s+(?:blocks?|sections?|components?|elements?)?\s*(?:in|into|to|for)\b/,
  /\b(?:move|reorder|rearrange)\s+(?:all|every|each)\s+(?:blocks?|sections?|components?)\b/,
  /\breoder\b/, // common typo for "reorder"
]

// ---------------------------------------------------------------------------
// Page listing — "list all pages", "what pages do I have"
// ---------------------------------------------------------------------------

export const PAGE_LIST_PATTERNS: RegExp[] = [
  /\blist\s+(all\s+)?(the\s+)?pages\b/,
  /\bshow\s+(me\s+)?(all\s+)?(the\s+)?pages\b/,
  /\bwhat\s+pages\s+(are|do|does|is)\b/,
  /\bwhich\s+pages\s+(are|do|does|is)\b/,
  /\bhow\s+many\s+pages\b/,
  /\bwhat\s+pages\s+(do\s+)?(i|we)\s+(have|got)\b/,
  /\b(all|my|the|our)\s+pages\b/
]

// ---------------------------------------------------------------------------
// Content queries — read-only questions about what's on the page
// "list all CTA buttons", "what images are on this page", "show me all links"
// ---------------------------------------------------------------------------

export const CONTENT_QUERY_PATTERNS: RegExp[] = [
  /\b(?:list|show|display|enumerate|find|what are)\b.*\b(?:cta|buttons?|links?|images?|headings?|titles?|texts?|urls?|hrefs?|sections?|blocks?)/,
  /\b(?:what|which|where|how many)\b.*\b(?:cta|buttons?|links?|images?|headings?|titles?|urls?|hrefs?)\b/,
  /\b(?:list|show|find)\s+(?:me\s+)?(?:all|every|each)\b.*\b(?:on|in|across)\s+(?:this|the)\s+(?:page|site)\b/,
  /\bhow\s+many\s+(?:cta|button|link|image|heading|section|block|card|feature|item|testimonial)/,
  /\bwhat\s+(?:does|is)\s+(?:the|this)\s+(?:page|site)\s+(?:about|contain|have|include)\b/,
  /\bwhat\s+(?:content|copy|text)\s+(?:is|does)\b.*\b(?:on|in)\s+(?:this|the)\s+page\b/,
  /\bsummarize\s+(?:this|the)\s+(?:page|content)\b/,
  /\bwhat\s+(?:blocks?|sections?)\s+(?:are|is)\s+(?:on|in)\s+(?:this|the)\s+page\b/,
  /\b(?:list|show|tell me)\b.*\b(?:all|every)\b.*\b(?:blocks?|sections?|components?)\b.*\b(?:on|in)\b/,
  /\b(?:audit|review|check|inspect|analyze)\s+(?:the\s+)?(?:page|content|copy|text|links?|images?|buttons?)\b/,
  /\bdescribe\s+(?:this|the|that)\s+(?:image|photo|picture|icon|logo|illustration)\b/,
]

// ---------------------------------------------------------------------------
// Exception modifier — "except", "but not", "other than", "all but"
// ---------------------------------------------------------------------------

export const EXCEPT_PATTERN = /\b(except|but not|other than|besides|everything but)\b|\ball\s+but\b/i

// ---------------------------------------------------------------------------
// "this one" / "this block" — refers to the currently-selected block
// ---------------------------------------------------------------------------

export const THIS_ONE_PATTERN = /\b(this\s+(?:one|block|section|component)|the\s+(?:selected|current|active)\s+(?:one|block|section|component))\b|\bthis\s*$/i
