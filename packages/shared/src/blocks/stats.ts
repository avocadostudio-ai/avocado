import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Stats", {
  schema: z.object({
    title: z.string().optional(),
    stats: z.array(z.object({
      icon: z.string().optional(),
      value: z.string().min(1),
      label: z.string().min(1),
      description: z.string().optional()
    })).min(1)
  }),
  meta: {
    displayName: "Stats",
    description: "Row of big numbers with labels (e.g. 10K+ Users).",
    category: "content",
    fields: { title: f.text("Section title"), headingLevel: f.headingLevel() },
    listFields: {
      stats: {
        label: "Stats",
        itemFields: {
          icon: f.text("Icon (emoji or image URL)"),
          value: f.text("Value"),
          label: f.text("Label"),
          description: f.text("Description"),
        }
      }
    }
  }
})

export function statsDefaultProps(): Record<string, unknown> {
  return {
    title: "By the numbers",
    stats: [
      { value: "10k+", label: "Active users" },
      { value: "99.9%", label: "Uptime" },
      { value: "24/7", label: "Support" }
    ]
  }
}
