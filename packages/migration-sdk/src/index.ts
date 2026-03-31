export { fetchPageContent, takeScreenshot, downloadImage, discoverSitePages, scrapeFullPage } from "./scraper.ts"
export { extractDesignTokens, mapToThemeVariables } from "./design-tokens.ts"
export { generateBlock, regenerateManifest } from "./block-codegen.ts"
export { extractSections, resolveLazyImages, extractNavigation, extractPageOutline, segmentByVisualGaps, detectRepeatedPatterns } from "./section-extractor.ts"
export { buildSectionSpec, buildPageSpecs } from "./section-spec.ts"
export type {
  FetchResult,
  ScreenshotResult,
  DownloadedImage,
  DesignTokens,
  ExtractedColor,
  ExtractedFont,
  ThemeVariables,
  BlockCodegenInput,
  BlockCodegenResult,
  FieldSpec,
  ListFieldSpec,
  FieldKind,
  SiteStructure,
  DiscoveredPage,
  ExtractedSection,
  FullPageScrape,
  NavExtraction,
  PageOutline,
  LayoutNode,
  VisualSection,
  RepeatGroup,
  ComputedStyleNode,
  SectionStyles,
  SectionSpec,
  ExtractedEmbed,
} from "./types.ts"
