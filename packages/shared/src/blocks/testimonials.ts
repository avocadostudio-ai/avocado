import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Testimonials", {
  schema: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ quote: z.string().min(1), author: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Testimonials",
    description: "Grid of testimonial cards with quotes and authors.",
    category: "content",
    fields: { title: f.text("Section title"), headingLevel: f.headingLevel() },
    listFields: {
      items: {
        label: "Testimonials",
        itemFields: { quote: f.longtext("Quote"), author: f.text("Author") }
      }
    }
  }
})

export function testimonialsDefaultProps(): Record<string, unknown> {
  return {
    title: "What customers say",
    items: [
      { quote: "We launched faster than expected.", author: "Alex" },
      { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
    ]
  }
}
