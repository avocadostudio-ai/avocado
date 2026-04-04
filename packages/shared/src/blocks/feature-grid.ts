import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("FeatureGrid", {
  schema: z.object({
    title: z.string().min(1),
    columns: z.enum(["2", "3", "4"]).default("3"),
    features: z.array(z.object({
      icon: z.string().optional(),
      title: z.string().min(1),
      description: z.string().min(1)
    })).min(1)
  }),
  meta: {
    displayName: "Feature Grid",
    description: "Grid of feature cards with optional icon, title, and description.",
    category: "content",
    fields: {
      title: f.text("Section title"),
      columns: { kind: "enum", label: "Columns", options: ["2", "3", "4"], inlineEditable: false },
      headingLevel: f.headingLevel(),
    },
    listFields: {
      features: {
        label: "Features",
        itemFields: {
          icon: f.text("Icon (emoji or image URL)"),
          title: f.text("Feature title"),
          description: f.longtext("Feature description"),
        }
      }
    }
  }
})

export function featureGridDefaultProps(): Record<string, unknown> {
  return {
    title: "Key features",
    columns: "3",
    features: [
      { icon: "\u26A1", title: "Fast setup", description: "Launch quickly with guided defaults." },
      { icon: "\uD83D\uDEE1\uFE0F", title: "Safe edits", description: "Structured operations keep content valid." },
      { icon: "\uD83D\uDD04", title: "Live updates", description: "Preview changes immediately." }
    ]
  }
}
