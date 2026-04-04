/**
 * Section spec generator — assembles block-type-agnostic section specifications
 * from extracted content, computed styles, and page outline data.
 *
 * The spec is a faithful representation of the source section, NOT a pre-mapped
 * prop bag. The LLM decides whether to use an existing block or code a new one.
 */

import type {
  ExtractedSection,
  SectionStyles,
  ComputedStyleNode,
  PageOutline,
  SectionSpec,
  FullPageScrape,
} from "./types.ts"
import { classifySection } from "./section-extractor.ts"

// ── Structure analysis helpers ──

function childSignature(node: ComputedStyleNode): string {
  return node.children
    .map((c) => c.tag)
    .join(" + ")
}

/** Detect repeated child patterns in a style tree */
function detectRepeats(root: ComputedStyleNode): { count: number; signature?: string } {
  if (root.children.length < 2) return { count: 0 }

  // Group children by their child-tag signature
  const sigMap = new Map<string, number>()
  for (const child of root.children) {
    const sig = childSignature(child)
    if (!sig) continue
    sigMap.set(sig, (sigMap.get(sig) ?? 0) + 1)
  }

  // Find the most frequent signature with 2+ occurrences
  let bestSig = ""
  let bestCount = 0
  for (const [sig, count] of sigMap) {
    if (count > bestCount) {
      bestCount = count
      bestSig = sig
    }
  }

  // Also check one level deeper — repeated items might be inside a wrapper div
  if (bestCount < 2) {
    for (const wrapper of root.children) {
      if (wrapper.children.length < 2) continue
      const innerSigMap = new Map<string, number>()
      for (const child of wrapper.children) {
        const sig = childSignature(child)
        if (!sig) continue
        innerSigMap.set(sig, (innerSigMap.get(sig) ?? 0) + 1)
      }
      for (const [sig, count] of innerSigMap) {
        if (count > bestCount) {
          bestCount = count
          bestSig = sig
        }
      }
    }
  }

  return bestCount >= 2 ? { count: bestCount, signature: bestSig } : { count: 0 }
}

/** Detect repeated patterns from content (headings at same level) when no style tree available */
function detectRepeatsFromContent(content: SectionSpec["content"]): { count: number; signature?: string } {
  // Count headings by level — repeated same-level headings suggest repeated items
  const levelCounts = new Map<number, number>()
  for (const h of content.headings) {
    levelCounts.set(h.level, (levelCounts.get(h.level) ?? 0) + 1)
  }

  // Find the level with most repetitions (minimum 2)
  let bestLevel = 0
  let bestCount = 0
  for (const [level, count] of levelCounts) {
    if (count > bestCount && count >= 2) {
      bestCount = count
      bestLevel = level
    }
  }

  if (bestCount >= 2) {
    // Check if there are also lists that correlate (e.g., pricing items with feature lists)
    const hasLists = content.lists.length > 0
    const signature = hasLists ? `h${bestLevel} + list` : `h${bestLevel}`
    return { count: bestCount, signature }
  }

  return { count: 0 }
}

/** Infer layout pattern from computed styles */
function inferPattern(
  root: ComputedStyleNode,
  repeats: { count: number; signature?: string },
): string {
  const s = root.styles
  const display = s.display ?? ""
  const flexDir = s.flexDirection ?? ""
  const gridCols = s.gridTemplateColumns ?? ""

  // Grid layout
  if (display === "grid" && gridCols) {
    const colCount = gridCols.split(/\s+/).filter((v) => v && v !== "0px").length
    if (repeats.count > 0) {
      return `${colCount}-column grid of ${repeats.count} items`
    }
    return `${colCount}-column grid`
  }

  // Flex row
  if (display === "flex" && flexDir === "row") {
    if (repeats.count > 0) return `horizontal row of ${repeats.count} items`
    return "side-by-side layout"
  }

  // Flex column (stacked)
  if (display === "flex" && (flexDir === "column" || !flexDir)) {
    if (repeats.count > 0) return `stacked list of ${repeats.count} items`
    return "vertically stacked"
  }

  // Fallback
  if (repeats.count > 0) return `${repeats.count} repeated items`
  return "single section"
}

/** Infer interaction model from section content and DOM structure */
function inferInteractionModel(
  section: ExtractedSection,
  root: ComputedStyleNode | undefined,
  repeats: { count: number; signature?: string },
): SectionSpec["structure"]["interactionModel"] {
  const html = section.rawHtml.toLowerCase()

  if (html.includes("<details") || html.includes("accordion")) return "accordion"
  if (html.includes("role=\"tablist\"") || html.includes("tab-content") || html.includes("tabpanel")) return "tabs"
  if (html.includes("carousel") || html.includes("swiper") || html.includes("slider") || html.includes("slick")) return "carousel"
  if (html.includes("scroll-snap") || html.includes("scroll-driven")) return "scroll-driven"

  // Horizontal scroll container with repeated items is likely a carousel
  if (root && repeats.count >= 3) {
    const overflow = root.styles.overflow ?? root.styles.overflowX ?? ""
    if ((overflow === "hidden" || overflow === "scroll") && root.styles.display === "flex" && root.styles.flexDirection === "row") {
      return "carousel"
    }
  }

  return "static"
}

function countElements(node: ComputedStyleNode): number {
  let count = 1
  for (const child of node.children) {
    count += countElements(child)
  }
  return count
}

// ── Style extraction helpers ──

function findFirst(
  node: ComputedStyleNode,
  predicate: (n: ComputedStyleNode) => boolean,
): ComputedStyleNode | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = findFirst(child, predicate)
    if (found) return found
  }
  return undefined
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])

/** Extract role-based style summaries from the computed style tree */
function extractRoleStyles(root: ComputedStyleNode, repeats: { count: number; signature?: string }) {
  const styles: SectionSpec["styles"] = {
    container: root.styles,
  }

  // Heading — first h1-h3
  const heading = findFirst(root, (n) => HEADING_TAGS.has(n.tag))
  if (heading) styles.heading = heading.styles

  // Body text — first <p>
  const bodyP = findFirst(root, (n) => n.tag === "p" && !!n.text && n.text.length > 10)
  if (bodyP) styles.bodyText = bodyP.styles

  // Repeated item — styles of first repeated child
  if (repeats.count > 0 && repeats.signature) {
    const sig = repeats.signature
    // Find first child whose signature matches
    for (const child of root.children) {
      if (childSignature(child) === sig) {
        styles.repeatedItem = child.styles
        break
      }
    }
    // Try one level deeper if not found
    if (!styles.repeatedItem) {
      for (const wrapper of root.children) {
        for (const child of wrapper.children) {
          if (childSignature(child) === sig) {
            styles.repeatedItem = child.styles
            break
          }
        }
        if (styles.repeatedItem) break
      }
    }
  }

  // CTA — first <a> or <button> with a background color
  const cta = findFirst(root, (n) => {
    if (n.tag !== "a" && n.tag !== "button") return false
    const bg = n.styles.backgroundColor ?? ""
    return !!bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent"
  })
  if (cta) styles.cta = cta.styles

  return styles
}

/** Build designNotes from extracted styles */
function buildDesignNotes(styles: SectionSpec["styles"]): SectionSpec["designNotes"] {
  const container = styles.container
  const heading = styles.heading ?? {}

  return {
    backgroundColor: container.backgroundColor ?? container.background ?? "",
    textColor: heading.color ?? styles.bodyText?.color ?? "",
    headingFont: heading.fontFamily ?? "",
    headingSize: heading.fontSize ?? "",
    layout: container.display ?? "block",
    hasGradient: !!(container.background ?? container.backgroundImage ?? "").includes("gradient"),
    hasShadow: !!(container.boxShadow ?? ""),
    borderRadius: container.borderRadius ?? "",
  }
}

// ── Public API ──

/**
 * Build a block-type-agnostic section spec from extracted content, computed styles,
 * and page outline data. The LLM uses this to decide: existing block or custom block.
 */
export function buildSectionSpec(
  section: ExtractedSection,
  sectionStyles?: SectionStyles,
  outlineSection?: PageOutline["sections"][number],
): SectionSpec {
  const root = sectionStyles?.root

  // Content — carry forward from section, enriching images with background flag
  const images = section.content.images.map((img) => ({
    src: img.src,
    alt: img.alt,
    isBackground: false,
  }))

  // Inject background images from computed styles
  if (root) {
    const bgImg = root.styles.backgroundImage ?? root.styles.background ?? ""
    const urlMatch = bgImg.match(/url\(["']?([^"')]+)["']?\)/)
    if (urlMatch?.[1] && !urlMatch[1].startsWith("data:")) {
      images.push({ src: urlMatch[1], alt: "", isBackground: true })
    }
  }

  const content: SectionSpec["content"] = {
    headings: section.content.headings,
    paragraphs: section.content.paragraphs,
    images,
    links: section.content.links,
    lists: section.content.lists,
  }

  // Structure analysis
  let repeats = root ? detectRepeats(root) : { count: 0 }

  // Content-based repeat detection fallback — when no style tree,
  // detect repeated patterns from headings at the same level
  if (repeats.count < 2 && !root && content.headings.length >= 2) {
    repeats = detectRepeatsFromContent(content)
  }

  const pattern = root ? inferPattern(root, repeats) : (repeats.count >= 2 ? `${repeats.count} repeated items` : "unknown")
  const interactionModel = inferInteractionModel(section, root, repeats)
  const elementCount = root ? countElements(root) : 0

  const structure: SectionSpec["structure"] = {
    pattern,
    repeatCount: repeats.count,
    repeatSignature: repeats.signature,
    elementCount,
    interactionModel,
  }

  // Styles — role-based summaries from computed style tree
  const roleStyles = root
    ? extractRoleStyles(root, repeats)
    : { container: {} }

  // Design notes
  const designNotes = buildDesignNotes(roleStyles)

  // Heuristic suggestion — carried from section extractor, not authoritative
  let suggestedBlockType = section.suggestedBlockType
  let suggestedConfidence = suggestedBlockType ? 0.5 : 0

  // Structural override: repeated items with headings should be CardGrid/FeatureGrid, not RichText
  if (repeats.count >= 2 && content.headings.length >= 2) {
    if (!suggestedBlockType || suggestedBlockType === "RichText") {
      const hasImages = content.images.length > 0 || content.links.length > 0
      suggestedBlockType = hasImages ? "CardGrid" : "FeatureGrid"
      suggestedConfidence = Math.max(suggestedConfidence, 0.6)
    }
  }

  // Structural override: h1 + image → Hero (overrides RichText since h1+image is hero-like)
  if (content.headings.some(h => h.level === 1) && content.images.length > 0 &&
      (!suggestedBlockType || suggestedBlockType === "RichText")) {
    suggestedBlockType = "Hero"
    suggestedConfidence = Math.max(suggestedConfidence, 0.7)
  }

  // Boost confidence if outline data corroborates
  if (outlineSection && suggestedBlockType) {
    if (outlineSection.repeatGroups && outlineSection.repeatGroups.length > 0) {
      suggestedConfidence = Math.min(suggestedConfidence + 0.15, 1)
    }
    if (outlineSection.type !== "unknown") {
      suggestedConfidence = Math.min(suggestedConfidence + 0.1, 1)
    }
  }

  // Boost if computed styles confirm the pattern
  if (root && suggestedBlockType) {
    if (repeats.count >= 3) suggestedConfidence = Math.min(suggestedConfidence + 0.1, 1)
    if (Object.keys(roleStyles.container).length > 5) suggestedConfidence = Math.min(suggestedConfidence + 0.05, 1)
  }

  return {
    sectionIndex: section.index,
    content,
    structure,
    styles: roleStyles,
    designNotes,
    suggestedBlockType,
    suggestedConfidence,
  }
}

/**
 * Build section specs for all sections of a scraped page.
 *
 * Uses visual sections (from bounding-box gap analysis) as the primary source
 * when available — this is CMS-agnostic and correctly identifies sections on
 * sites that don't use semantic HTML tags. Falls back to regex-based
 * extractSections() when visual data isn't available.
 */
export function buildPageSpecs(scrape: FullPageScrape): SectionSpec[] {
  const stylesMap = new Map<number, SectionStyles>()
  if (scrape.sectionStyles) {
    for (const ss of scrape.sectionStyles) {
      stylesMap.set(ss.sectionIndex, ss)
    }
  }

  // Collect ALL images from all regex-extracted sections for redistribution by Y-position
  const allExtractedImages = scrape.sections.flatMap((s) =>
    s.content.images.map((img) => ({ ...img, sectionIndex: s.index }))
  )

  // Build fallback content map for sections where findElementForRange failed
  const fallbackMap = new Map<number, NonNullable<FullPageScrape["sectionFallbackContent"]>[number]>()
  if (scrape.sectionFallbackContent) {
    for (const fb of scrape.sectionFallbackContent) {
      fallbackMap.set(fb.sectionIndex, fb)
    }
  }

  // If we have visual sections AND computed styles from them, use those as primary
  if (scrape.visualSections && scrape.visualSections.length > 0 && scrape.sectionStyles && scrape.sectionStyles.length > 0) {
    return scrape.visualSections.map((vs, i) => {
      const styles = stylesMap.get(i)
      const styleHeadings = styles?.root ? findHeadingTexts(styles.root) : []

      // Match by heading text first, then by content overlap
      const matchedSection = scrape.sections.find((s) =>
        s.content.headings.some((h) => styleHeadings.includes(h.text))
      )

      // Find matching outline section
      const outlineSection = scrape.outline.sections.find((os) =>
        os.heading && styleHeadings.includes(os.heading)
      ) ?? scrape.outline.sections[i]

      // Build content: start with matched section's content (best images from regex parser),
      // then enrich with style tree data and page-level image data for anything missing
      const styleContent = extractContentFromStyleTree(styles?.root, scrape.embeds, vs, scrape.videos)
      const baseContent = matchedSection?.content ?? { headings: [], paragraphs: [], images: [], links: [], lists: [] }

      // Fallback content from Y-range text scan (for sections where findElementForRange failed)
      const fallback = fallbackMap.get(i)

      // Collect page images that fall within this visual section's Y range
      const sectionPageImages: Array<{ src: string; alt: string; isLazy: boolean }> = []
      if (scrape.pageImages) {
        for (const img of scrape.pageImages) {
          if (img.y >= vs.y && img.y < vs.y + vs.height) {
            sectionPageImages.push({ src: img.src, alt: img.alt, isLazy: false })
          }
        }
      }

      // Merge content from all sources: regex-extracted > style tree > fallback Y-scan
      const mergedContent: ExtractedSection["content"] = {
        headings: pickFirst(baseContent.headings, styleContent.headings, fallback?.headings ?? []),
        paragraphs: pickFirst(baseContent.paragraphs, styleContent.paragraphs, fallback?.paragraphs ?? []),
        images: mergeImages(mergeImages(baseContent.images, sectionPageImages), styleContent.images),
        links: pickFirst(baseContent.links, styleContent.links, fallback?.links ?? []),
        lists: pickFirst(baseContent.lists, styleContent.lists, fallback?.lists ?? []),
      }

      // Classify if no type inherited from matched regex section
      let suggestedBlockType = matchedSection?.suggestedBlockType
      let classHints = matchedSection?.classHints ?? []
      if (!suggestedBlockType && matchedSection?.rawHtml) {
        const classified = classifySection(
          `<${matchedSection.tag}>`,
          matchedSection.rawHtml,
          { headings: mergedContent.headings },
        )
        suggestedBlockType = classified.suggestedBlockType
        if (classified.classHints.length > 0) classHints = classified.classHints
      }
      // Also classify from style tree content if still unclassified
      if (!suggestedBlockType && styles?.root) {
        const treeHtml = reconstructHtmlFromStyleTree(styles.root)
        if (treeHtml.length > 20) {
          const classified = classifySection("<div>", treeHtml, { headings: mergedContent.headings })
          suggestedBlockType = classified.suggestedBlockType
          if (classified.classHints.length > 0) classHints = classified.classHints
        }
      }

      const section: ExtractedSection = {
        index: i,
        tag: matchedSection?.tag ?? "div",
        classHints,
        suggestedBlockType,
        content: mergedContent,
        rawHtml: matchedSection?.rawHtml ?? "",
      }

      const spec = buildSectionSpec(section, styles, outlineSection)

      // Attach interaction states captured during interaction sweep
      if (scrape.interactionStates) {
        const sectionInteractions = scrape.interactionStates
          .filter(is => is.sectionY >= vs.y && is.sectionY < vs.y + vs.height)
          .flatMap(is => is.states)
        if (sectionInteractions.length > 0) {
          spec.interactionStates = sectionInteractions
        }
      }

      return spec
    })
  }

  // Fallback: use regex-based sections
  return scrape.sections.map((section, i) => {
    const styles = stylesMap.get(i)
    const outlineSection = scrape.outline.sections[i]
    return buildSectionSpec(section, styles, outlineSection)
  })
}

/** Reconstruct approximate HTML from a computed style tree for classification heuristics. */
function reconstructHtmlFromStyleTree(node: ComputedStyleNode): string {
  const parts: string[] = []
  if (node.text) {
    const tag = HEADING_TAGS.has(node.tag) ? node.tag : "p"
    parts.push(`<${tag}>${node.text}</${tag}>`)
  }
  if (node.image) {
    parts.push(`<img src="${node.image}" alt="">`)
  }
  for (const child of node.children) {
    parts.push(reconstructHtmlFromStyleTree(child))
  }
  return parts.join("")
}

/** Return the first non-empty array from the candidates. */
function pickFirst<T>(...candidates: T[][]): T[] {
  for (const c of candidates) {
    if (c.length > 0) return c
  }
  return []
}

/** Merge images from two sources, deduplicating by src. */
function mergeImages(
  a: Array<{ src: string; alt: string; isLazy?: boolean; isBackground?: boolean }>,
  b: Array<{ src: string; alt: string; isLazy?: boolean; isBackground?: boolean }>,
): Array<{ src: string; alt: string; isLazy: boolean }> {
  const seen = new Set<string>()
  const result: Array<{ src: string; alt: string; isLazy: boolean }> = []
  for (const img of [...a, ...b]) {
    if (!img.src || seen.has(img.src)) continue
    seen.add(img.src)
    result.push({ src: img.src, alt: img.alt, isLazy: (img as { isLazy?: boolean }).isLazy ?? false })
  }
  return result
}

/** Extract heading texts from a computed style tree for section matching. */
function findHeadingTexts(node: ComputedStyleNode): string[] {
  const texts: string[] = []
  if (HEADING_TAGS.has(node.tag) && node.text) texts.push(node.text)
  for (const child of node.children) {
    texts.push(...findHeadingTexts(child))
  }
  return texts
}

/** Build content from a computed style tree when no regex-extracted section matches. */
function extractContentFromStyleTree(
  root: ComputedStyleNode | undefined,
  embeds: FullPageScrape["embeds"],
  vs: import("./types.ts").VisualSection,
  videos?: FullPageScrape["videos"],
): ExtractedSection["content"] {
  const headings: Array<{ level: number; text: string }> = []
  const paragraphs: string[] = []
  const images: Array<{ src: string; alt: string; isLazy: boolean }> = []
  const links: Array<{ href: string; text: string }> = []

  if (root) {
    walkForContent(root, headings, paragraphs, images)
  }

  // Add embeds that fall within this visual section's Y range
  if (embeds) {
    for (const embed of embeds) {
      if (embed.y >= vs.y && embed.y < vs.y + vs.height) {
        links.push({ href: embed.src, text: `[${embed.type} embed]` })
      }
    }
  }

  // Add <video> elements that fall within this visual section's Y range
  if (videos) {
    for (const video of videos) {
      if (video.y >= vs.y && video.y < vs.y + vs.height) {
        links.push({ href: video.src, text: `[video${video.autoplay ? " autoplay" : ""}${video.loop ? " loop" : ""}]` })
        if (video.poster) {
          images.push({ src: video.poster, alt: "Video poster", isLazy: false })
        }
      }
    }
  }

  return { headings, paragraphs, images, links, lists: [] }
}

/** Recursively extract content from a computed style tree. */
function walkForContent(
  node: ComputedStyleNode,
  headings: Array<{ level: number; text: string }>,
  paragraphs: string[],
  images: Array<{ src: string; alt: string; isLazy: boolean }>,
) {
  if (HEADING_TAGS.has(node.tag) && node.text) {
    const level = parseInt(node.tag[1])
    headings.push({ level, text: node.text })
  } else if (node.tag === "p" && node.text && node.text.length > 10) {
    paragraphs.push(node.text)
  }
  if (node.image) {
    images.push({ src: node.image.src, alt: node.image.alt, isLazy: false })
  }
  // Check for background images
  const bgImg = node.styles.backgroundImage ?? ""
  const bgMatch = bgImg.match(/url\(["']?([^"')]+)["']?\)/)
  if (bgMatch?.[1] && !bgMatch[1].startsWith("data:")) {
    images.push({ src: bgMatch[1], alt: "", isLazy: false })
  }
  for (const child of node.children) {
    walkForContent(child, headings, paragraphs, images)
  }
}
