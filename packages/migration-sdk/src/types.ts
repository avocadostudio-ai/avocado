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

/** Combined result from scrapeFullPage — one Puppeteer session */
export type FullPageScrape = {
  content: FetchResult
  screenshot: ScreenshotResult | null
  sections: ExtractedSection[]
  outline: PageOutline
  nav?: NavExtraction
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
