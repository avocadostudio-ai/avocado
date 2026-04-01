import { z } from "zod"
import { registerBlock } from "@ai-site-editor/shared"

const PricingColumnSchema = z.object({
  duration: z.string().min(1),
  category: z.string().min(1),
  days: z.string().min(1),
  price: z.string().min(1),
  unit: z.string().min(1),
  inclusions: z.array(z.string()).optional(),
})

registerBlock("PricingTable", {
  schema: z.object({
    title: z.string().optional(),
    footerNote: z.string().optional(),
    columns: z.array(PricingColumnSchema).min(1),
  }),
  meta: {
    displayName: "Pricing Table",
    description: "Side-by-side pricing tiers with inclusions.",
    category: "conversion",
    fields: {
      title: { kind: "text", label: "Title" },
      footerNote: { kind: "text", label: "Footer Note", multiline: true },
    },
    listFields: {
      columns: {
        label: "Pricing Tiers",
        itemFields: {
          duration: { kind: "text", label: "Duration" },
          category: { kind: "text", label: "Category" },
          days: { kind: "text", label: "Days" },
          price: { kind: "text", label: "Price" },
          unit: { kind: "text", label: "Unit" },
        },
      },
    },
  },
})
