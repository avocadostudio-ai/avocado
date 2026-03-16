export const rendererBlockTypes = [
  "Hero",
  "FeatureGrid",
  "Testimonials",
  "FAQAccordion",
  "CTA",
  "Card",
  "CardGrid",
  "RichText",
  "Stats",
  "TwoColumn",
  "Footer",
  "SiteHeader",
  "Embed",
  "Banner",
  "Carousel",
  "Gallery",
  "Tabs",
  "Table",
  "Quote",
  "Video"
] as const

export type RendererBlockType = (typeof rendererBlockTypes)[number]
