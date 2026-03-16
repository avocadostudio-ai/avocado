import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("FAQAccordion", {
  schema: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "FAQ Accordion",
    description: "Expandable question-and-answer section.",
    category: "content",
    fields: { title: f.text("Section title"), headingLevel: f.headingLevel() },
    listFields: {
      items: {
        label: "FAQ items",
        itemFields: { q: f.text("Question"), a: f.longtext("Answer") }
      }
    }
  }
})

export function faqAccordionDefaultProps(): Record<string, unknown> {
  return {
    title: "Frequently asked questions",
    items: [
      { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
      { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
    ]
  }
}
