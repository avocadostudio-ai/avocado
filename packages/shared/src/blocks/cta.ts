import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("CTA", {
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    secondaryCtaText: z.string().optional(),
    secondaryCtaHref: z.string().optional()
  }),
  meta: {
    displayName: "Call to Action",
    description: "Centered promotional section with primary and optional secondary button.",
    category: "conversion",
    fields: {
      title: f.text("Headline"),
      description: f.longtext("Description"),
      ctaText: f.text("Button text"),
      ctaHref: f.url("Button link"),
      secondaryCtaText: f.text("Secondary button text"),
      secondaryCtaHref: f.url("Secondary button link"),
      headingLevel: f.headingLevel(),
    }
  }
})

export function ctaDefaultProps(): Record<string, unknown> {
  return {
    title: "Ready to get started?",
    description: "Apply your next change in seconds.",
    ctaText: "Start now",
    ctaHref: "/"
  }
}
