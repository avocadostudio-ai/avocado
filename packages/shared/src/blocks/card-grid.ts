import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("CardGrid", {
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    columns: z.enum(["2", "3", "4"]).default("3"),
    cardVariant: z.enum(["default", "full-bleed"]).default("default"),
    cards: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().min(1),
          ctaText: z.string().min(1),
          ctaHref: z.string().min(1),
          imageUrl: z.string().min(1).optional(),
          imageAlt: z.string().min(1).optional()
        })
      )
      .min(1)
  }),
  meta: {
    displayName: "Card Grid",
    description: "Grid of cards, each with title, description, and CTA.",
    category: "content",
    fields: {
      title: f.text("Section title"),
      subtitle: f.text("Subtitle"),
      columns: { kind: "enum", label: "Columns", options: ["2", "3", "4"], inlineEditable: false },
      cardVariant: { kind: "enum", label: "Card style", options: ["default", "full-bleed"], inlineEditable: false },
      headingLevel: f.headingLevel(),
    },
    listFields: {
      cards: {
        label: "Cards",
        itemFields: {
          title: f.text("Card title"),
          description: f.longtext("Card description"),
          ctaText: f.text("Button text"),
          ctaHref: f.url("Button link"),
          imageUrl: f.image("Card image", { aspectRatio: "landscape", width: 768, height: 512 }),
          imageAlt: f.imageAlt("Card image alt text"),
        }
      }
    }
  }
})

export function cardGridDefaultProps(): Record<string, unknown> {
  return {
    title: "Explore more",
    columns: "3",
    cards: [
      {
        title: "Fast setup",
        description: "Create and ship updates quickly.",
        ctaText: "Get started",
        ctaHref: "/"
      },
      {
        title: "Safe updates",
        description: "Schema-validated edits reduce breakage.",
        ctaText: "See how",
        ctaHref: "/pricing"
      },
      {
        title: "Team workflow",
        description: "Collaborate with clear, reviewable changes.",
        ctaText: "Read guide",
        ctaHref: "/"
      }
    ]
  }
}
