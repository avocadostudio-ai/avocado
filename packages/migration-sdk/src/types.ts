// ── Scraper types ──

export type FetchResult = {
  html: string
  css: string
  baseUrl: string
  title: string
  metaDescription: string
}

export type ScreenshotResult = {
  base64: string
  viewport: { width: number; height: number }
}

export type DownloadedImage = {
  localPath: string
  fileName: string
  width: number
  height: number
}

// ── Design token types ──

export type ColorUsage = "background" | "text" | "accent" | "border"

export type ExtractedColor = {
  value: string
  usage: ColorUsage
  frequency: number
  /** CSS property where the color was found (e.g. "background-color", "color") */
  property: string
}

export type ExtractedFont = {
  family: string
  usage: "heading" | "body" | "mono"
}

export type DesignTokens = {
  colors: ExtractedColor[]
  fonts: ExtractedFont[]
  radii: string[]
}

/** Maps to the site's CSS custom properties (--bg-0, --brand, etc.) */
export type ThemeVariables = Record<string, string>

// ── Block codegen types ──

export type FieldKind =
  | "text"
  | "richtext"
  | "url"
  | "image"
  | "imageAlt"
  | "color"
  | "enum"
  | "number"

export type FieldSpec = {
  name: string
  kind: FieldKind
  label: string
  required: boolean
  imageSpec?: { aspectRatio: "landscape" | "square" | "portrait"; width: number; height: number }
  enumOptions?: string[]
}

export type ListFieldSpec = {
  name: string
  label: string
  itemFields: FieldSpec[]
}

export type BlockCodegenInput = {
  /** PascalCase block name, e.g. "PricingTable" */
  name: string
  description: string
  category: "content" | "media" | "layout" | "conversion"
  fields: FieldSpec[]
  listFields?: ListFieldSpec[]
  defaultProps: Record<string, unknown>
  /** CSS template using design system variables */
  cssTemplate: string
  /** JSX body — inner content of the <section> wrapper */
  rendererJsx: string
  /** Target directory for generated files, e.g. "apps/site/blocks" */
  outputDir: string
}

export type BlockCodegenResult = {
  blockType: string
  filesCreated: string[]
  manifestUpdated: string
}

// ── Section extraction types ──

export type ExtractedSection = {
  /** Position on page (0-based) */
  index: number
  /** Original HTML tag (section, div, article, etc.) */
  tag: string
  /** Element id attribute if present */
  id?: string
  /** Semantic CSS class hints extracted from class list */
  classHints: string[]
  /** Heuristic block type suggestion based on class/content analysis */
  suggestedBlockType?: string
  /** Structured content extracted from the section */
  content: {
    headings: Array<{ level: number; text: string }>
    paragraphs: string[]
    images: Array<{ src: string; alt: string; isLazy: boolean }>
    links: Array<{ href: string; text: string }>
    lists: string[][]
  }
  /** Trimmed inner HTML (max ~5KB) */
  rawHtml: string
}

/** Compact page outline — captures full page structure in ~3KB regardless of HTML size */
export type PageOutline = {
  /** All headings in document order */
  headings: Array<{ level: number; text: string }>
  /** Visual sections split at h1/h2 boundaries — each may contain sub-items from h3s */
  sections: Array<{
    /** Inferred section type */
    type: "hero" | "features" | "cards" | "pricing" | "cta" | "text" | "gallery" | "faq" | "stats" | "contact" | "video" | "info-hub" | "unknown"
    /** Section heading (from h1/h2) */
    heading?: string
    /** First ~120 chars of text content */
    contentSummary: string
    /** Sub-items from h3 headings within this section */
    subItems?: string[]
    imageCount: number
    linkCount: number
    listItemCount: number
    hasForm: boolean
    hasPricing: boolean
    hasVideo: boolean
    /** Elementor widget types found in this section */
    widgetTypes?: string[]
    /** Repeated element patterns detected visually */
    repeatGroups?: RepeatGroup[]
    /** How this section was detected */
    detectedBy?: "heading" | "visual-gap" | "both"
  }>
  totalImages: number
  totalLinks: number
}

// ── Visual layout types ──

export type LayoutNode = {
  tag: string
  depth: number
  rect: { x: number; y: number; w: number; h: number }
  text: string
  childCount: number
  imgCount: number
  linkCount: number
  classes: string
  role: string
  widgetType: string
}

export type VisualSection = {
  y: number
  height: number
  nodes: LayoutNode[]
  textLength: number
  imgCount: number
  linkCount: number
}

export type RepeatGroup = {
  signature: string
  count: number
  inferredType: "card" | "feature" | "pricing" | "stat" | "testimonial" | "unknown"
  itemTexts: string[]
}

/** Extracted navigation structure from the source site */
export type NavExtraction = {
  siteName?: string
  logoUrl?: string
  items: Array<{
    label: string
    href?: string
    children?: Array<{ label: string; href: string }>
  }>
}

/** Embedded iframe (YouTube, Vimeo, Google Maps, etc.) */
export type ExtractedEmbed = {
  src: string
  type: "youtube" | "vimeo" | "map" | "other"
  /** Y position on the page (for correlating with visual sections) */
  y: number
  width: number
  height: number
}

/** Combined result from scrapeFullPage — one Playwright session */
export type FullPageScrape = {
  content: FetchResult
  /** Desktop screenshot (1440px viewport) */
  screenshot: ScreenshotResult | null
  /** Mobile screenshot (390px viewport) */
  mobileScreenshot: ScreenshotResult | null
  sections: ExtractedSection[]
  outline: PageOutline
  nav?: NavExtraction
  /** Per-section computed CSS styles (from getComputedStyle walker, keyed by visual section index) */
  sectionStyles?: SectionStyles[]
  /** Visual sections detected by bounding-box gap analysis (CMS-agnostic) */
  visualSections?: VisualSection[]
  /** Embedded iframes found on the page */
  embeds?: ExtractedEmbed[]
  /** Actual rendered fonts from getComputedStyle (more reliable than CSS regex) */
  computedFonts?: { heading: string | null; body: string | null; googleFontLinks: string[] }
  /** All <img> elements on the page with Y positions (for distributing to visual sections) */
  pageImages?: Array<{ src: string; alt: string; y: number; width: number; height: number }>
}

// ── Computed style extraction types ──

/** A DOM node with its computed CSS styles extracted via getComputedStyle().
 *  The walker recurses 4 levels deep from each section root. */
export type ComputedStyleNode = {
  tag: string
  depth: number
  /** Nth-child selector path for debugging (e.g. "section:nth-child(2) > div:nth-child(1) > h1") */
  selector: string
  /** Filtered computed CSS properties — only non-default values */
  styles: Record<string, string>
  /** Direct text content (first 200 chars, leaf nodes only) */
  text: string | null
  /** Image info if this is an <img> element */
  image: { src: string; alt: string; naturalWidth: number; naturalHeight: number } | null
  children: ComputedStyleNode[]
}

/** Computed styles for one page section, keyed by section index */
export type SectionStyles = {
  sectionIndex: number
  root: ComputedStyleNode
}

// ── Section spec types ──

/** Block-type-agnostic section specification.
 *  Rich enough for the LLM to map to an existing block OR hand to block-coder
 *  for a custom block. No pre-mapped props — the LLM decides. */
export type SectionSpec = {
  sectionIndex: number

  /** Content extracted from the section */
  content: {
    headings: Array<{ level: number; text: string }>
    paragraphs: string[]
    images: Array<{ src: string; alt: string; isBackground: boolean }>
    links: Array<{ href: string; text: string }>
    lists: string[][]
  }

  /** DOM structure summary — what the section looks like structurally */
  structure: {
    /** e.g. "3-column grid of cards", "hero with side image", "accordion" */
    pattern: string
    /** Number of repeated child groups (0 = no repetition) */
    repeatCount: number
    /** Signature of repeated items (e.g. "img + h3 + p + a") */
    repeatSignature?: string
    /** Total element count in the section */
    elementCount: number
    /** Interaction model inferred from DOM */
    interactionModel: "static" | "accordion" | "tabs" | "carousel" | "scroll-driven"
  }

  /** Exact computed CSS values from getComputedStyle() — the key data
   *  that lets the LLM or block-coder reproduce the visual design */
  styles: {
    /** Section container styles */
    container: Record<string, string>
    /** Heading styles (first heading found) */
    heading?: Record<string, string>
    /** Body text styles */
    bodyText?: Record<string, string>
    /** Repeated item styles (if repeatCount > 0, styles of first item) */
    repeatedItem?: Record<string, string>
    /** CTA/button styles (if links/buttons present) */
    cta?: Record<string, string>
  }

  /** Design characteristics derived from computed styles */
  designNotes: {
    backgroundColor: string
    textColor: string
    headingFont: string
    headingSize: string
    layout: string
    hasGradient: boolean
    hasShadow: boolean
    borderRadius: string
  }

  /** Heuristic suggestion — NOT authoritative. LLM decides final block type. */
  suggestedBlockType?: string
  /** Heuristic confidence (0-1) for the suggestion */
  suggestedConfidence: number
}

// ── Site structure discovery types ──

export type DiscoveredPage = {
  url: string
  slug: string
  title?: string
}

export type SiteStructure = {
  origin: string
  pages: DiscoveredPage[]
  source: "sitemap" | "robots" | "links" | "single"
  totalFound: number
}
