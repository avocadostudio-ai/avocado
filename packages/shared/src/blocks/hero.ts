import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Hero", {
  schema: z.object({
    heading: z.string().min(1),
    subheading: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    imagePosition: z.enum(["left", "right"]).default("right"),
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
      imagePosition: { kind: "enum", label: "Image position", options: ["left", "right"], inlineEditable: false },
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
    imageUrl: "/hero-generated.svg",
    imageAlt: "Abstract generated illustration",
    imagePosition: "right"
  }
}
