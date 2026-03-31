/**
 * HTML section extractor — converts raw HTML into structured sections
 * for LLM-based block mapping.
 *
 * Instead of sending 50KB of raw HTML to the LLM, this module identifies
 * semantic section boundaries, classifies them by CSS class patterns,
 * extracts structured content, and resolves lazy-loaded images.
 */

import type { ExtractedSection, NavExtraction, PageOutline, LayoutNode, VisualSection, RepeatGroup } from "./types.ts"

/** CSS class/id patterns → suggested block type */
const CLASS_PATTERNS: Array<{ pattern: RegExp; blockType: string }> = [
  // Navigation/chrome (skip)
  { pattern: /\b(header|nav|navbar|menu|top-bar|site-header)\b/i, blockType: "__header__" },
  { pattern: /\b(footer|site-footer|bottom-bar)\b/i, blockType: "__footer__" },
  // Content blocks
  { pattern: /\b(hero|banner|jumbotron|masthead|cover|above-fold)\b/i, blockType: "Hero" },
  { pattern: /\b(features?|benefits?|services?|usp|advantages?|why-us|icon-box)\b/i, blockType: "FeatureGrid" },
  { pattern: /\b(testimonials?|reviews?|quote|feedback|client-say|customer-say)\b/i, blockType: "Testimonials" },
  { pattern: /\b(faq|accordion|question|q-and-a)\b/i, blockType: "FAQAccordion" },
  { pattern: /\b(pricing|plan|tier|price-table|price-card)\b/i, blockType: "CardGrid" },
  { pattern: /\b(stat|counter|number|metric|count-up|fun-fact)\b/i, blockType: "Stats" },
  { pattern: /\b(gallery|portfolio|lightbox|image-grid|photo)\b/i, blockType: "Gallery" },
  { pattern: /\b(team|member|staff|people|employee|about-us)\b/i, blockType: "CardGrid" },
  { pattern: /\b(cta|call-to-action|contact-form|get-started|sign-up)\b/i, blockType: "CTA" },
  { pattern: /\b(card|grid|post|blog|news|article-list)\b/i, blockType: "CardGrid" },
  { pattern: /\b(tab|tabbed|tab-content)\b/i, blockType: "Tabs" },
  { pattern: /\b(carousel|slider|swiper|slideshow)\b/i, blockType: "Carousel" },
  { pattern: /\b(video|youtube|vimeo|media-player)\b/i, blockType: "Video" },
  { pattern: /\b(embed|iframe|map|widget)\b/i, blockType: "Embed" },
  { pattern: /\b(table|data-table|comparison)\b/i, blockType: "Table" },
  { pattern: /\b(rich-text|text-block|content-area|wysiwyg)\b/i, blockType: "RichText" },
  { pattern: /\b(two-col|split|columns|side-by-side)\b/i, blockType: "TwoColumn" },
]

/** Elementor-specific widget type → block type */
const ELEMENTOR_WIDGET_MAP: Record<string, string> = {
  "heading": "RichText",
  "text-editor": "RichText",
  "image": "Gallery",
  "image-box": "FeatureGrid",
  "icon-box": "FeatureGrid",
  "icon-list": "FeatureGrid",
  "counter": "Stats",
  "testimonial": "Testimonials",
  "tabs": "Tabs",
  "accordion": "FAQAccordion",
  "toggle": "FAQAccordion",
  "video": "Video",
  "image-gallery": "Gallery",
  "image-carousel": "Carousel",
  "google-maps": "Embed",
  "button": "CTA",
  "call-to-action": "CTA",
  "price-table": "CardGrid",
  "price-list": "CardGrid",
}

/** Attributes that hold lazy-loaded image sources */
const LAZY_SRC_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-bg", "data-background-image"]

// ── HTML parsing helpers (regex-based, no external DOM parser) ──

/** Extract attribute value from a tag string */
function getAttr(tag: string, attr: string): string | null {
  // Match attr="value" or attr='value'
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")
  const m = tag.match(re)
  return m ? (m[1] ?? m[2] ?? null) : null
}

/** Strip HTML tags, decode basic entities, collapse whitespace */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Check if inline style contains display:none or visibility:hidden */
function isHidden(tag: string): boolean {
  const style = getAttr(tag, "style")
  if (!style) return false
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style)
}

// ── Content extraction from a section's HTML ──

function extractHeadings(sectionHtml: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = []
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sectionHtml)) !== null) {
    const text = stripTags(m[2])
    if (text) headings.push({ level: Number(m[1]), text })
  }
  return headings
}

function extractParagraphs(sectionHtml: string): string[] {
  const paragraphs: string[] = []
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sectionHtml)) !== null) {
    const text = stripTags(m[1])
    if (text && text.length > 5) paragraphs.push(text)
  }
  return paragraphs
}

function extractImages(sectionHtml: string, baseUrl: string): Array<{ src: string; alt: string; isLazy: boolean }> {
  const images: Array<{ src: string; alt: string; isLazy: boolean }> = []
  const re = /<img[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sectionHtml)) !== null) {
    const tag = m[0]
    let src = getAttr(tag, "src") ?? ""
    let isLazy = false

    // Check lazy-load attributes
    for (const attr of LAZY_SRC_ATTRS) {
      const lazySrc = getAttr(tag, attr)
      if (lazySrc && lazySrc.startsWith("http")) {
        src = lazySrc
        isLazy = true
        break
      }
    }

    // Check srcset for highest resolution
    const srcset = getAttr(tag, "srcset")
    if (srcset && !src.startsWith("http")) {
      const parts = srcset.split(",").map(s => s.trim().split(/\s+/))
      const best = parts.sort((a, b) => {
        const aW = parseInt(a[1] ?? "0")
        const bW = parseInt(b[1] ?? "0")
        return bW - aW
      })[0]
      if (best?.[0]) { src = best[0]; isLazy = true }
    }

    // Resolve relative URLs
    if (src && !src.startsWith("data:") && !src.startsWith("http")) {
      try { src = new URL(src, baseUrl).href } catch { /* keep as-is */ }
    }

    // Skip tiny placeholders, data URIs, and tracking pixels
    if (!src || src.startsWith("data:") || src.includes("pixel") || src.includes("spacer")) continue

    const alt = getAttr(tag, "alt") ?? ""
    images.push({ src, alt, isLazy })
  }

  // Check background images: inline styles, data-bg attributes, Elementor data attributes
  const bgPatterns = [
    // Inline style background-image
    /style\s*=\s*["'][^"']*background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/gi,
    // Elementor data-bg attribute
    /data-bg\s*=\s*["']([^"']+)["']/gi,
    // Generic data-background attributes
    /data-background(?:-image)?\s*=\s*["']([^"']+)["']/gi,
    // data-src on non-img elements (lazy background)
    /data-src\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|avif))["']/gi,
  ]
  for (const bgRe of bgPatterns) {
    let bgm: RegExpExecArray | null
    while ((bgm = bgRe.exec(sectionHtml)) !== null) {
      let src = bgm[1]
      if (src && !src.startsWith("data:")) {
        try { src = new URL(src, baseUrl).href } catch { /* keep as-is */ }
        if (!images.some(img => img.src === src)) {
          images.push({ src, alt: "", isLazy: true })
        }
      }
    }
  }

  return images
}

function extractLinks(sectionHtml: string, baseUrl: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = []
  const re = /<a[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sectionHtml)) !== null) {
    let href = m[1] ?? m[2] ?? ""
    const text = stripTags(m[4])
    if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue
    if (!href.startsWith("http")) {
      try { href = new URL(href, baseUrl).href } catch { continue }
    }
    if (text) links.push({ href, text })
  }
  return links
}

function extractLists(sectionHtml: string): string[][] {
  const lists: string[][] = []
  const listRe = /<(?:ul|ol)[^>]*>([\s\S]*?)<\/(?:ul|ol)>/gi
  let m: RegExpExecArray | null
  while ((m = listRe.exec(sectionHtml)) !== null) {
    const itemRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
    const items: string[] = []
    let im: RegExpExecArray | null
    while ((im = itemRe.exec(m[1])) !== null) {
      const text = stripTags(im[1])
      if (text) items.push(text)
    }
    if (items.length > 0) lists.push(items)
  }
  return lists
}

// ── Section boundary detection ──

/** Find top-level section containers in HTML */
function findSectionBoundaries(html: string): Array<{ tag: string; openTag: string; startIdx: number; endIdx: number; innerHTML: string }> {
  const sections: Array<{ tag: string; openTag: string; startIdx: number; endIdx: number; innerHTML: string }> = []

  // Try semantic tags first
  const semanticRe = /<(section|article|aside)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = semanticRe.exec(html)) !== null) {
    sections.push({
      tag: m[1],
      openTag: `<${m[1]}${m[2]}>`,
      startIdx: m.index,
      endIdx: m.index + m[0].length,
      innerHTML: m[3],
    })
  }

  // If we found semantic sections, use them
  if (sections.length > 0) return sections

  // Strategy 2: Try Elementor containers
  const elementorRe = /<div([^>]*class="[^"]*(?:elementor-section|e-con(?:\s|"))[^"]*"[^>]*)>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:elementor-section|e-con(?:\s|"))[^"]*"|<\/(?:main|body)>|$)/gi
  while ((m = elementorRe.exec(html)) !== null) {
    sections.push({
      tag: "div",
      openTag: `<div${m[1]}>`,
      startIdx: m.index,
      endIdx: m.index + m[0].length,
      innerHTML: m[2],
    })
  }
  if (sections.length > 0) return sections

  // Strategy 3: Top-level divs inside <main> or <body>
  // Find <main> content first, fall back to <body>
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const containerHtml = mainMatch?.[1] ?? html

  // Match top-level divs with id or class
  const divRe = /<div([^>]*(?:id|class)\s*=[^>]*)>([\s\S]*?)<\/div>(?=\s*<div[^>]*(?:id|class)\s*=|\s*<\/(?:main|body)>|\s*$)/gi
  while ((m = divRe.exec(containerHtml)) !== null) {
    const innerText = stripTags(m[2])
    if (innerText.length < 20) continue // Skip tiny divs
    sections.push({
      tag: "div",
      openTag: `<div${m[1]}>`,
      startIdx: m.index,
      endIdx: m.index + m[0].length,
      innerHTML: m[2],
    })
  }

  return sections
}

/** Classify a section by its CSS classes and content */
function classifySection(openTag: string, innerHTML: string, preExtracted?: { headings: Array<{ level: number; text: string }> }): { classHints: string[]; suggestedBlockType?: string } {
  const classAttr = getAttr(openTag, "class") ?? ""
  const idAttr = getAttr(openTag, "id") ?? ""
  const combined = `${classAttr} ${idAttr}`.toLowerCase()

  // Extract semantic class hints
  const classHints: string[] = []
  const hintPatterns = [
    "hero", "banner", "feature", "testimonial", "faq", "accordion", "pricing",
    "stat", "counter", "gallery", "team", "cta", "contact", "card", "grid",
    "tab", "carousel", "slider", "video", "embed", "table", "quote",
    "footer", "header", "nav", "menu", "rich-text", "two-col", "split",
  ]
  for (const hint of hintPatterns) {
    if (combined.includes(hint)) classHints.push(hint)
  }

  // Check Elementor widget type
  const widgetType = getAttr(openTag, "data-widget_type")?.replace(/\.\w+$/, "")
  if (widgetType && ELEMENTOR_WIDGET_MAP[widgetType]) {
    classHints.push(`elementor:${widgetType}`)
    return { classHints, suggestedBlockType: ELEMENTOR_WIDGET_MAP[widgetType] }
  }

  // Match against class patterns
  for (const { pattern, blockType } of CLASS_PATTERNS) {
    if (pattern.test(combined)) {
      return { classHints, suggestedBlockType: blockType }
    }
  }

  // Content-based heuristics when classes don't help
  const headings = preExtracted?.headings ?? extractHeadings(innerHTML)
  const images = (innerHTML.match(/<img[^>]*>/gi) ?? []).length
  const links = (innerHTML.match(/<a[^>]*>/gi) ?? []).length
  const detailsTags = (innerHTML.match(/<details[^>]*>/gi) ?? []).length
  const listItems = (innerHTML.match(/<li[^>]*>/gi) ?? []).length
  const tables = (innerHTML.match(/<table[^>]*>/gi) ?? []).length

  if (detailsTags >= 2) return { classHints, suggestedBlockType: "FAQAccordion" }
  if (tables > 0) return { classHints, suggestedBlockType: "Table" }
  if (images >= 4 && links < 2) return { classHints, suggestedBlockType: "Gallery" }
  if (images >= 2 && links >= 2) return { classHints, suggestedBlockType: "CardGrid" }

  // First section with h1 + image is likely Hero
  if (headings.some(h => h.level === 1) && images >= 1) {
    return { classHints, suggestedBlockType: "Hero" }
  }

  // Section with many list items and no images → FeatureGrid
  if (listItems >= 3 && images === 0) return { classHints, suggestedBlockType: "FeatureGrid" }

  // Numeric content → Stats
  const text = stripTags(innerHTML)
  const numberMatches = text.match(/\b\d[\d,.]*[+%]?\b/g) ?? []
  if (numberMatches.length >= 3 && text.length < 500) {
    return { classHints, suggestedBlockType: "Stats" }
  }

  // Short section with 1-2 links → CTA
  if (text.length < 300 && links >= 1 && headings.length <= 1) {
    return { classHints, suggestedBlockType: "CTA" }
  }

  // Default: RichText for text-heavy sections
  if (text.length > 100) return { classHints, suggestedBlockType: "RichText" }

  return { classHints }
}

// ── Main export ──

/**
 * Extract structured sections from HTML.
 *
 * Identifies section boundaries using semantic tags, Elementor containers,
 * and generic div analysis. Classifies each section by CSS class patterns
 * and content heuristics. Resolves lazy-loaded images.
 */
export function extractSections(html: string, baseUrl: string): ExtractedSection[] {
  // Strip scripts and style blocks to reduce noise
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")

  const boundaries = findSectionBoundaries(cleanHtml)
  const sections: ExtractedSection[] = []
  const MAX_SECTIONS = 30

  for (let i = 0; i < boundaries.length && sections.length < MAX_SECTIONS; i++) {
    const { tag, openTag, innerHTML } = boundaries[i]

    // Skip hidden elements
    if (isHidden(openTag)) continue

    // Skip empty sections (but keep sections with images even if text is short)
    const text = stripTags(innerHTML)
    const hasImages = /<img[^>]*>/i.test(innerHTML)
    if (text.length < 10 && !hasImages) continue

    // Extract content first (reused by classifier)
    const content = {
      headings: extractHeadings(innerHTML),
      paragraphs: extractParagraphs(innerHTML),
      images: extractImages(innerHTML, baseUrl),
      links: extractLinks(innerHTML, baseUrl),
      lists: extractLists(innerHTML),
    }

    // Classify using pre-extracted content
    const { classHints, suggestedBlockType } = classifySection(openTag, innerHTML, content)

    // Skip chrome sections
    if (suggestedBlockType === "__header__" || suggestedBlockType === "__footer__") continue

    // Trim rawHtml to max ~5KB
    const rawHtml = innerHTML.length > 5000
      ? innerHTML.slice(0, 5000) + "\n<!-- truncated -->"
      : innerHTML

    sections.push({
      index: sections.length,
      tag,
      id: getAttr(openTag, "id") ?? undefined,
      classHints,
      suggestedBlockType,
      content,
      rawHtml,
    })
  }

  return sections
}

/**
 * Extract navigation structure from the source site's HTML.
 * Looks for <nav> or <header> elements and extracts link hierarchy.
 */
// ── Visual layout analysis ──

const VISUAL_GAP_THRESHOLD = 60 // px gap between sections
const MIN_REPEAT_GROUP = 3

/**
 * Segment layout nodes into visual sections by detecting vertical gaps.
 */
export function segmentByVisualGaps(nodes: LayoutNode[], viewportWidth = 1440): VisualSection[] {
  // Find section-level elements: wide enough to be sections, not so tall they're page wrappers.
  // Use depth <= 5 to handle deeply nested CMS layouts (WordPress/Elementor often nest at depth 3-5).
  // Exclude elements taller than 3000px (likely full-page wrappers, not individual sections).
  const topLevel = nodes
    .filter(n => n.depth <= 5 && n.rect.w > viewportWidth * 0.5 && n.rect.h < 3000 && n.rect.h >= 100)
    .sort((a, b) => a.rect.y - b.rect.y)

  // Deduplicate overlapping nodes — keep the shallowest (most likely the section root)
  const deduped: LayoutNode[] = []
  for (const node of topLevel) {
    const overlaps = deduped.some(existing =>
      Math.abs(existing.rect.y - node.rect.y) < 50 && Math.abs(existing.rect.h - node.rect.h) < 50
    )
    if (!overlaps) deduped.push(node)
  }
  const filtered = deduped.length > 0 ? deduped : topLevel

  if (filtered.length === 0) return []

  const sections: VisualSection[] = []
  let currentNodes: LayoutNode[] = [filtered[0]]

  for (let i = 1; i < filtered.length; i++) {
    const prev = filtered[i - 1]
    const curr = filtered[i]
    const gap = curr.rect.y - (prev.rect.y + prev.rect.h)

    if (gap > VISUAL_GAP_THRESHOLD) {
      // Gap detected — flush current section
      sections.push(buildVisualSection(currentNodes, nodes))
      currentNodes = [curr]
    } else {
      currentNodes.push(curr)
    }
  }
  if (currentNodes.length > 0) {
    sections.push(buildVisualSection(currentNodes, nodes))
  }

  return sections
}

function buildVisualSection(sectionNodes: LayoutNode[], allNodes: LayoutNode[]): VisualSection {
  const y = Math.min(...sectionNodes.map(n => n.rect.y))
  const maxBottom = Math.max(...sectionNodes.map(n => n.rect.y + n.rect.h))
  // Include all descendant nodes within this Y range
  const contained = allNodes.filter(n => n.rect.y >= y && n.rect.y + n.rect.h <= maxBottom + 10)
  return {
    y,
    height: maxBottom - y,
    nodes: contained,
    textLength: contained.reduce((sum, n) => sum + n.text.length, 0),
    imgCount: contained.reduce((sum, n) => sum + n.imgCount, 0),
    linkCount: contained.reduce((sum, n) => sum + n.linkCount, 0),
  }
}

/**
 * Detect repeated structural patterns within a set of layout nodes.
 * Groups nodes by structural signature and classifies repeat groups.
 */
export function detectRepeatedPatterns(nodes: LayoutNode[]): RepeatGroup[] {
  // Only consider leaf-ish nodes (depth 2-5, not too deep)
  const candidates = nodes.filter(n => n.depth >= 2 && n.depth <= 6 && n.text.length > 5)

  // Compute structural signature for each node
  function signature(n: LayoutNode): string {
    const textBucket = n.text.length === 0 ? "0" : n.text.length < 50 ? "S" : n.text.length < 200 ? "M" : "L"
    return `${n.tag}|c${n.childCount}|i${n.imgCount > 0 ? 1 : 0}|l${n.linkCount > 0 ? 1 : 0}|t${textBucket}|w${Math.round(n.rect.w / 50) * 50}`
  }

  // Group by signature
  const groups = new Map<string, LayoutNode[]>()
  for (const node of candidates) {
    const sig = signature(node)
    const group = groups.get(sig)
    if (group) group.push(node)
    else groups.set(sig, [node])
  }

  // Filter to groups with 3+ items
  const repeatGroups: RepeatGroup[] = []
  for (const [sig, items] of groups) {
    if (items.length < MIN_REPEAT_GROUP) continue

    // Classify the repeat group
    const hasImages = items.every(n => n.imgCount > 0)
    const hasLinks = items.every(n => n.linkCount > 0)
    const avgTextLen = items.reduce((s, n) => s + n.text.length, 0) / items.length
    const hasPricing = items.some(n => /(?:CHF|€|\$|Fr\.)\s*\d|\d+[.,]\d{2}/i.test(n.text))
    const hasNumbers = items.every(n => /\b\d[\d,.]*[+%]?\b/.test(n.text)) && avgTextLen < 80

    let inferredType: RepeatGroup["inferredType"] = "unknown"
    if (hasPricing) inferredType = "pricing"
    else if (hasNumbers && avgTextLen < 80) inferredType = "stat"
    else if (hasImages && hasLinks) inferredType = "card"
    else if (hasImages) inferredType = "card"
    else if (avgTextLen < 100) inferredType = "feature"
    else if (avgTextLen > 150) inferredType = "testimonial"

    repeatGroups.push({
      signature: sig,
      count: items.length,
      inferredType,
      itemTexts: items.map(n => n.text.slice(0, 50)),
    })
  }

  // Sort by count descending
  return repeatGroups.sort((a, b) => b.count - a.count)
}

// ── Page outline extractor ──

type OutlineSection = PageOutline["sections"][number]

const PRICING_RE = /(?:CHF|€|\$|USD|EUR|Fr\.)\s*\d|\bab\s+\d|\d+[.,]\d{2}\s*(?:CHF|€|\$|Fr\.)/i
const CONTACT_RE = /\b(?:kontakt|contact|adresse|address|öffnungszeiten|opening\s+hours|standort|location|anfahrt|directions)\b/i
const VIDEO_RE = /<(?:video|iframe)[^>]*(?:youtube|vimeo|video)/i

/**
 * Classify a text chunk into a section type based on content patterns.
 */
function classifyOutlineSection(
  heading: string,
  text: string,
  innerHTML: string,
  imageCount: number,
  linkCount: number,
  listItemCount: number,
): OutlineSection["type"] {
  const combined = `${heading} ${text}`.toLowerCase()

  // Check specific content patterns
  if (/<details[^>]*>/i.test(innerHTML)) return "faq"
  if (PRICING_RE.test(text)) return "pricing"
  if (CONTACT_RE.test(combined)) return "contact"
  if (VIDEO_RE.test(innerHTML)) return "video"
  if (/<form[^>]*>/i.test(innerHTML)) return "contact"

  // Check heading/class patterns
  if (/\b(hero|banner|erlebnis|experience|willkommen|welcome)\b/i.test(combined)) return "hero"
  if (/\b(feature|vorteil|benefit|service|leistung|usp|vorteile)\b/i.test(combined)) return "features"
  if (/\b(testimonial|review|bewertung|kundenstimme|feedback)\b/i.test(combined)) return "text"
  if (/\b(gallerie|gallery|fotos?|photos?|bilder|portfolio)\b/i.test(combined)) return "gallery"
  if (/\b(faq|fragen|questions?|häufig)\b/i.test(combined)) return "faq"
  if (/\b(preis|price|pricing|tarif|paket|package|angebot)\b/i.test(combined)) return "pricing"
  if (/\b(team|mitarbeiter|staff|member|über\s+uns|about\s+us)\b/i.test(combined)) return "cards"
  if (/\b(event|veranstaltung|anlass|teamevent|polterabend|geburtstag)\b/i.test(combined)) return "cards"
  if (/\b(info|download|link|resource|dokument|formulare?)\b/i.test(combined) && linkCount >= 3) return "info-hub"
  if (/\b(buche|book|reserv|jetzt|start|anfrage|contact)\b/i.test(combined) && text.length < 300) return "cta"

  // Infer from content shape
  if (imageCount >= 4 && linkCount < 3) return "gallery"
  if (imageCount >= 2 && linkCount >= 2) return "cards"
  if (listItemCount >= 3 && imageCount === 0 && text.length < 500) return "features"

  // Large numbers → stats
  const numberMatches = text.match(/\b\d[\d,.]*[+%]?\b/g) ?? []
  if (numberMatches.length >= 3 && text.length < 400) return "stats"

  // Short text with link → CTA
  if (text.length < 250 && linkCount >= 1) return "cta"

  // Default: text block
  if (text.length > 50) return "text"

  return "unknown"
}

/**
 * Extract a compact page outline from HTML.
 *
 * Splits the page at heading boundaries (h1/h2) to produce a section-per-heading
 * representation that captures the FULL page structure in ~2KB regardless of HTML size.
 * This ensures the LLM sees every section even when the raw HTML is truncated.
 */
export function extractPageOutline(html: string, baseUrl: string, layoutNodes?: LayoutNode[]): PageOutline {
  // Strip scripts and styles
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")

  // Extract ALL headings in document order
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
  const allHeadings: Array<{ level: number; text: string; index: number }> = []
  let hm: RegExpExecArray | null
  while ((hm = headingRe.exec(cleanHtml)) !== null) {
    const text = stripTags(hm[2]).trim()
    if (text && text.length > 1) {
      allHeadings.push({ level: Number(hm[1]), text, index: hm.index })
    }
  }

  // Count total images and links
  const totalImages = (cleanHtml.match(/<img[^>]*>/gi) ?? []).length
  const totalLinks = (cleanHtml.match(/<a[^>]*href/gi) ?? []).length

  // Split at h1/h2 boundaries — h3+ become sub-items within the parent section
  const majorHeadings = allHeadings.filter(h => h.level <= 2)

  if (majorHeadings.length === 0) {
    const text = stripTags(cleanHtml).slice(0, 120)
    return {
      headings: allHeadings.map(h => ({ level: h.level, text: h.text })),
      sections: [{
        type: classifyOutlineSection("", text, cleanHtml, totalImages, totalLinks, 0),
        contentSummary: text,
        imageCount: totalImages,
        linkCount: totalLinks,
        listItemCount: 0,
        hasForm: /<form[^>]*>/i.test(cleanHtml),
        hasPricing: PRICING_RE.test(cleanHtml),
        hasVideo: VIDEO_RE.test(cleanHtml),
      }],
      totalImages,
      totalLinks,
    }
  }

  const sections: OutlineSection[] = []

  // Pre-heading content (nav, hero above first h1/h2)
  const preHeadingHtml = cleanHtml.slice(0, majorHeadings[0].index)
  const preHeadingText = stripTags(preHeadingHtml).trim()
  if (preHeadingText.length > 30) {
    const imgCount = (preHeadingHtml.match(/<img[^>]*>/gi) ?? []).length
    const lnkCount = (preHeadingHtml.match(/<a[^>]*href/gi) ?? []).length
    sections.push({
      type: imgCount > 0 ? "hero" : "text",
      contentSummary: preHeadingText.slice(0, 120),
      imageCount: imgCount,
      linkCount: lnkCount,
      listItemCount: 0,
      hasForm: false,
      hasPricing: false,
      hasVideo: VIDEO_RE.test(preHeadingHtml),
    })
  }

  // Build sections at h1/h2 boundaries, collecting h3s as sub-items
  for (let i = 0; i < majorHeadings.length; i++) {
    const startIdx = majorHeadings[i].index
    const endIdx = i + 1 < majorHeadings.length ? majorHeadings[i + 1].index : cleanHtml.length
    const chunkHtml = cleanHtml.slice(startIdx, endIdx)
    const chunkText = stripTags(chunkHtml).trim()

    if (chunkText.length < 3) continue

    // Collect h3 sub-headings within this section
    const subItems = allHeadings
      .filter(h => h.level >= 3 && h.index > startIdx && h.index < endIdx)
      .map(h => h.text)

    const imgCount = (chunkHtml.match(/<img[^>]*>/gi) ?? []).length
    const lnkCount = (chunkHtml.match(/<a[^>]*href/gi) ?? []).length
    const liCount = (chunkHtml.match(/<li[^>]*>/gi) ?? []).length
    const widgetTypes = [...chunkHtml.matchAll(/data-widget_type="([^"]+)"/gi)].map(m => m[1].replace(/\.\w+$/, ""))
    const hasPricing = PRICING_RE.test(chunkText)

    // Classify with content awareness
    let sectionType = classifyOutlineSection(
      majorHeadings[i].text, chunkText, chunkHtml, imgCount, lnkCount, liCount,
    )

    // Info hub detection: section with many toggle/accordion sub-items
    if (subItems.length >= 3 && widgetTypes.includes("toggle")) sectionType = "info-hub"
    // Cards detection: section heading + multiple h3 sub-items with CTAs
    if (subItems.length >= 3 && lnkCount >= subItems.length) sectionType = "cards"

    sections.push({
      type: sectionType,
      heading: majorHeadings[i].text,
      contentSummary: chunkText.slice(0, 120),
      ...(subItems.length > 0 ? { subItems } : {}),
      imageCount: imgCount,
      linkCount: lnkCount,
      listItemCount: liCount,
      hasForm: /<form[^>]*>/i.test(chunkHtml),
      hasPricing,
      hasVideo: VIDEO_RE.test(chunkHtml),
      ...(widgetTypes.length > 0 ? { widgetTypes: [...new Set(widgetTypes)] } : {}),
    })
  }

  // Enrich with visual layout data if available
  if (layoutNodes && layoutNodes.length > 0) {
    // Find Y positions of each section's heading in the layout
    const sectionYs: number[] = sections.map(s => {
      if (!s.heading) return 0
      const heading = s.heading.slice(0, 40) // match prefix to handle truncation
      // Try exact h tag first, then any node containing the heading text
      const node = layoutNodes.find(n => /^h[1-3]$/i.test(n.tag) && n.text.includes(heading))
        ?? layoutNodes.find(n => n.text.includes(heading) && n.rect.h < 200)
      return node?.rect.y ?? 0
    })

    // For each section, detect repeat patterns from layout nodes in its Y range
    for (let i = 0; i < sections.length; i++) {
      const yStart = sectionYs[i]
      const yEnd = i + 1 < sectionYs.length && sectionYs[i + 1] > yStart
        ? sectionYs[i + 1]
        : yStart + 1500

      // Only include nodes whose CENTER is within this section's range
      const nodesInRange = layoutNodes.filter(n => {
        const centerY = n.rect.y + n.rect.h / 2
        return centerY >= yStart && centerY < yEnd
      })
      if (nodesInRange.length < 3) { sections[i].detectedBy = "heading"; continue }

      const repeats = detectRepeatedPatterns(nodesInRange)
      if (repeats.length > 0) {
        sections[i].repeatGroups = repeats.slice(0, 2)
      }
      sections[i].detectedBy = "both"
    }

    // Check for visual-gap sections not covered by headings
    const visualSections = segmentByVisualGaps(layoutNodes)
    for (const vs of visualSections) {
      const coveredByHeading = sectionYs.some(sy => sy >= vs.y && sy < vs.y + vs.height)
      if (!coveredByHeading && vs.textLength > 30) {
        const repeats = detectRepeatedPatterns(vs.nodes)
        const firstText = vs.nodes.find(n => n.text.length > 5)?.text.slice(0, 120) ?? ""
        const inferredType = repeats.length > 0
          ? (repeats[0].inferredType === "feature" ? "features" as const : "cards" as const)
          : "unknown" as const

        sections.push({
          type: inferredType,
          contentSummary: firstText,
          imageCount: vs.imgCount,
          linkCount: vs.linkCount,
          listItemCount: 0,
          hasForm: false,
          hasPricing: vs.nodes.some(n => PRICING_RE.test(n.text)),
          hasVideo: false,
          repeatGroups: repeats.length > 0 ? repeats.slice(0, 3) : undefined,
          detectedBy: "visual-gap",
        })
      }
    }
  }

  return {
    headings: allHeadings.map(h => ({ level: h.level, text: h.text })),
    sections,
    totalImages,
    totalLinks,
  }
}

// ── Navigation extraction ──

export function extractNavigation(html: string, baseUrl: string): NavExtraction {
  const origin = new URL(baseUrl).origin

  // Find logo image in header/nav area
  const headerMatch = html.match(/<(?:header|nav)[^>]*>([\s\S]*?)<\/(?:header|nav)>/i)
  const headerHtml = headerMatch?.[1] ?? ""
  let logoUrl: string | undefined
  let siteName: string | undefined

  // Look for logo: img inside a link to "/" or brand/logo class
  const logoImgMatch = headerHtml.match(/<a[^>]*href\s*=\s*["']\/["'][^>]*>[\s\S]*?<img[^>]*src\s*=\s*["']([^"']+)["']/i)
    ?? headerHtml.match(/<img[^>]*class\s*=\s*["'][^"']*logo[^"']*["'][^>]*src\s*=\s*["']([^"']+)["']/i)
    ?? headerHtml.match(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*logo[^"']*["']/i)
  if (logoImgMatch?.[1]) {
    logoUrl = logoImgMatch[1]
    if (logoUrl && !logoUrl.startsWith("http") && !logoUrl.startsWith("data:")) {
      try { logoUrl = new URL(logoUrl, baseUrl).href } catch { /* keep */ }
    }
  }

  // Look for site name in header brand text
  const brandMatch = headerHtml.match(/<a[^>]*href\s*=\s*["']\/["'][^>]*>([\s\S]*?)<\/a>/i)
  if (brandMatch) {
    const brandText = stripTags(brandMatch[1]).trim()
    if (brandText && brandText.length < 60) siteName = brandText
  }

  // Extract nav links — handle both flat and nested (dropdown) structures
  const items: NavExtraction["items"] = []

  // Find all <nav> elements
  const navRe = /<nav[^>]*>([\s\S]*?)<\/nav>/gi
  let navMatch: RegExpExecArray | null
  let navHtml = ""
  while ((navMatch = navRe.exec(html)) !== null) {
    navHtml += navMatch[1]
  }
  if (!navHtml) navHtml = headerHtml

  // Find top-level <li> items (may contain nested <ul> for dropdowns)
  const seenHrefs = new Set<string>()
  const MAX_NAV_ITEMS = 15
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  let liMatch: RegExpExecArray | null
  while ((liMatch = liRe.exec(navHtml)) !== null) {
    if (items.length >= MAX_NAV_ITEMS) break
    const liContent = liMatch[1]

    // Check for nested <ul> (dropdown)
    const subMenuMatch = liContent.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i)
    const linkMatch = liContent.match(/<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)

    if (subMenuMatch && linkMatch) {
      // Parent with children
      const parentLabel = stripTags(linkMatch[2]).trim()
      const parentHref = linkMatch[1]
      const children: Array<{ label: string; href: string }> = []

      const childLiRe = /<li[^>]*>[\s\S]*?<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
      let childMatch: RegExpExecArray | null
      while ((childMatch = childLiRe.exec(subMenuMatch[1])) !== null) {
        let childHref = childMatch[1]
        const childLabel = stripTags(childMatch[2]).trim()
        if (!childLabel || childHref.startsWith("#") || childHref.startsWith("javascript:")) continue
        if (!childHref.startsWith("http")) {
          try { childHref = new URL(childHref, baseUrl).href } catch { continue }
        }
        if (childHref.startsWith(origin)) {
          children.push({ label: childLabel, href: new URL(childHref).pathname })
        }
      }

      // Deduplicate children
      const dedupedChildren = children.filter(c => {
        if (seenHrefs.has(c.href)) return false
        seenHrefs.add(c.href)
        return true
      })

      if (dedupedChildren.length > 0) {
        items.push({ label: parentLabel, children: dedupedChildren })
      } else if (parentLabel) {
        let href = parentHref
        if (!href.startsWith("http")) {
          try { href = new URL(href, baseUrl).href } catch { /* skip */ }
        }
        if (href.startsWith(origin)) {
          const path = new URL(href).pathname
          if (!seenHrefs.has(path)) {
            seenHrefs.add(path)
            items.push({ label: parentLabel, href: path })
          }
        }
      }
    } else if (linkMatch) {
      let href = linkMatch[1]
      const label = stripTags(linkMatch[2]).trim()
      if (!label || href.startsWith("#") || href.startsWith("javascript:")) continue
      if (!href.startsWith("http")) {
        try { href = new URL(href, baseUrl).href } catch { continue }
      }
      if (href.startsWith(origin)) {
        const path = new URL(href).pathname
        if (!seenHrefs.has(path)) {
          seenHrefs.add(path)
          items.push({ label, href: path })
        }
      }
    }
  }

  return { siteName, logoUrl, items }
}

/**
 * Resolve lazy-loaded image sources in HTML.
 * Replaces data-src, data-lazy-src, etc. with actual src attributes.
 */
export function resolveLazyImages(html: string): string {
  // For each <img> tag, if it has a lazy-src attribute, replace/add src
  return html.replace(/<img[^>]*>/gi, (imgTag) => {
    for (const attr of LAZY_SRC_ATTRS) {
      const re = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, "i")
      const m = imgTag.match(re)
      if (m && m[1]) {
        const lazyValue = m[1]
        // Remove the data-* attribute
        let newTag = imgTag.replace(re, "")
        // Replace or add src
        if (/\bsrc\s*=\s*"/i.test(newTag)) {
          newTag = newTag.replace(/\bsrc\s*=\s*"[^"]*"/i, `src="${lazyValue}"`)
        } else {
          newTag = newTag.replace(/<img/i, `<img src="${lazyValue}"`)
        }
        return newTag.replace(/\s+/g, " ").replace(/\s+>/g, ">")
      }
    }
    return imgTag
  })
}
