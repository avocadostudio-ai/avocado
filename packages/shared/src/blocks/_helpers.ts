import type { FieldMeta, ImageSpec } from "./_registry.ts"

export const f = {
  text: (label?: string): FieldMeta => ({ kind: "text", label }),
  longtext: (label?: string): FieldMeta => ({ kind: "text", label, multiline: true }),
  richtext: (label?: string): FieldMeta => ({ kind: "richtext", label }),
  url: (label?: string): FieldMeta => ({ kind: "url", label, inlineEditable: false }),
  image: (label?: string, imageSpec?: ImageSpec): FieldMeta => ({ kind: "image", label, inlineEditable: false, ...(imageSpec ? { imageSpec } : {}) }),
  imageAlt: (label?: string): FieldMeta => ({ kind: "imageAlt", label }),
  headingLevel: (): FieldMeta => ({ kind: "headingLevel", label: "Heading type", inlineEditable: false }),
} as const

export const DEFAULT_HEADING_LEVELS: Record<string, string> = {
  Hero: "h1", FeatureGrid: "h2", Testimonials: "h2", FAQAccordion: "h2",
  CTA: "h2", Card: "h3", CardGrid: "h2", RichText: "h2",
  Stats: "h2", TwoColumn: "h2", Footer: "h4",
}

export function resolveHeadingTag(blockType: string, props: Record<string, unknown>): string {
  const v = props.headingLevel
  if (typeof v === "string" && /^h[1-6]$/.test(v)) return v
  return DEFAULT_HEADING_LEVELS[blockType] ?? "h2"
}
