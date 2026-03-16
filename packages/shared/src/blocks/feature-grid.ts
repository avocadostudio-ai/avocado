import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("FeatureGrid", {
  schema: z.object({
    title: z.string().min(1),
    features: z.array(z.object({ title: z.string().min(1), description: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Feature Grid",
    description: "Grid of feature cards with title and description.",
    category: "content",
    fields: { title: f.text("Section title"), headingLevel: f.headingLevel() },
    listFields: {
      features: {
        label: "Features",
        itemFields: { title: f.text("Feature title"), description: f.longtext("Feature description") }
      }
    }
  }
})

export function featureGridDefaultProps(): Record<string, unknown> {
  return {
    title: "Key features",
    features: [
      { title: "Fast setup", description: "Launch quickly with guided defaults." },
      { title: "Safe edits", description: "Structured operations keep content valid." },
      { title: "Live updates", description: "Preview changes immediately." }
    ]
  }
}
