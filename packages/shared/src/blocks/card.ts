import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Card", {
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    imageUrl: z.string().min(1).optional(),
    imageAlt: z.string().min(1).optional()
  }),
  meta: {
    displayName: "Card",
    description: "Single prominent card with a CTA.",
    category: "content",
    fields: {
      title: f.text("Card title"),
      description: f.longtext("Card description"),
      ctaText: f.text("Button text"),
      ctaHref: f.url("Button link"),
      imageUrl: f.image("Card image", { aspectRatio: "landscape", width: 768, height: 512 }),
      imageAlt: f.imageAlt("Card image alt text"),
      headingLevel: f.headingLevel(),
    }
  }
})

export function cardDefaultProps(): Record<string, unknown> {
  return {
    title: "Launch faster",
    description: "Go from idea to published changes in minutes.",
    ctaText: "Learn more",
    ctaHref: "/pricing"
  }
}
