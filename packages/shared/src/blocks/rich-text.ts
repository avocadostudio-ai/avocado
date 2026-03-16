import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("RichText", {
  schema: z.object({
    title: z.string(),
    body: z.string().min(1)
  }),
  meta: {
    displayName: "Rich Text",
    description: "Freeform text content with markdown-style formatting.",
    category: "content",
    fields: {
      title: f.text("Section title"),
      body: f.richtext("Body"),
      headingLevel: f.headingLevel(),
    }
  }
})

export function richTextDefaultProps(): Record<string, unknown> {
  return {
    title: "",
    body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
  }
}
