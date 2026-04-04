import { z } from "zod"
import { registerBlock, IMAGE_PLACEHOLDER } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Hero", {
  schema: z.object({
    heading: z.string().min(1),
    subheading: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    imagePosition: z.enum(["left", "right", "full"]).default("right"),
    textAlign: z.enum(["left", "center"]).default("left"),
    eyebrow: z.string().optional(),
    secondaryCtaText: z.string().optional(),
    secondaryCtaHref: z.string().optional()
  }),
  meta: {
    displayName: "Hero",
    description: "Full-width hero section with headline, subheading, CTA buttons, and image.",
    category: "content",
    fields: {
      heading: f.text("Heading"),
      subheading: f.text("Subheading"),
      ctaText: f.text("CTA button text"),
      ctaHref: f.url("CTA link"),
      imageUrl: f.image("Hero image", { aspectRatio: "landscape", width: 1536, height: 1024 }),
      imageAlt: f.imageAlt("Hero image alt text"),
      imagePosition: { kind: "enum", label: "Image position", options: ["left", "right", "full"], inlineEditable: false },
      textAlign: { kind: "enum", label: "Text alignment", options: ["left", "center"], inlineEditable: false },
      eyebrow: f.text("Eyebrow text"),
      secondaryCtaText: f.text("Secondary CTA text"),
      secondaryCtaHref: f.url("Secondary CTA link"),
      headingLevel: f.headingLevel(),
    }
  }
})

export function heroDefaultProps(): Record<string, unknown> {
  return {
    heading: "Build with confidence",
    subheading: "Make changes safely with instant preview.",
    ctaText: "Get Started",
    ctaHref: "/",
    imageUrl: IMAGE_PLACEHOLDER,
    imageAlt: "Abstract generated illustration",
    imagePosition: "right"
  }
}
