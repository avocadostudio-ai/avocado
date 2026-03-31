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
  const repeats = root ? detectRepeats(root) : { count: 0 }
  const pattern = root ? inferPattern(root, repeats) : "unknown"
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
  const suggestedBlockType = section.suggestedBlockType
  let suggestedConfidence = suggestedBlockType ? 0.5 : 0

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

  // If we have visual sections AND computed styles from them, use those as primary
  if (scrape.visualSections && scrape.visualSections.length > 0 && scrape.sectionStyles && scrape.sectionStyles.length > 0) {
    return scrape.visualSections.map((vs, i) => {
      const styles = stylesMap.get(i)

      // Find the best matching extractedSection by Y-position overlap
      const matchedSection = scrape.sections.find((s) => {
        // ExtractedSection doesn't have Y position, so match by content overlap
        // Use the first heading text as a proxy for matching
        if (!styles?.root) return false
        const styleHeadings = findHeadingTexts(styles.root)
        return s.content.headings.some((h) => styleHeadings.includes(h.text))
      })

      // Find matching outline section
      const outlineSection = scrape.outline.sections.find((os) => {
        if (!os.heading) return false
        const styleHeadings = styles?.root ? findHeadingTexts(styles.root) : []
        return styleHeadings.includes(os.heading)
      }) ?? scrape.outline.sections[i]

      // Build a synthetic ExtractedSection from the visual section + computed styles
      const section: ExtractedSection = matchedSection ?? {
        index: i,
        tag: "div",
        classHints: [],
        content: extractContentFromStyleTree(styles?.root, scrape.embeds, vs),
        rawHtml: "",
      }

      // Override the index to match the visual section order
      const sectionWithIndex = { ...section, index: i }
      return buildSectionSpec(sectionWithIndex, styles, outlineSection)
    })
  }

  // Fallback: use regex-based sections
  return scrape.sections.map((section, i) => {
    const styles = stylesMap.get(i)
    const outlineSection = scrape.outline.sections[i]
    return buildSectionSpec(section, styles, outlineSection)
  })
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
