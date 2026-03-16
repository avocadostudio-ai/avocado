import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Footer", {
  schema: z.object({
    copyright: z.string().min(1),
    columns: z.array(z.object({ title: z.string().min(1), links: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Footer",
    description: "Multi-column footer with link groups and copyright.",
    category: "navigation",
    chrome: true,
    fields: { copyright: f.text("Copyright text"), headingLevel: f.headingLevel() },
    listFields: {
      columns: {
        label: "Footer columns",
        itemFields: { title: f.text("Column title"), links: f.richtext("Links (one label|url per line)") }
      }
    }
  }
})

export function footerDefaultProps(): Record<string, unknown> {
  return {
    copyright: "\u00a9 2026 Your Company",
    columns: [
      { title: "Product", links: "Features|/features\nPricing|/pricing" },
      { title: "Company", links: "About|/about\nContact|/contact" }
    ]
  }
}
