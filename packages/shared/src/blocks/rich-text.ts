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
    title: "About this page",
    body: [
      "Rich text supports **bold**, *italic*, and [inline links](https://example.com) so you can weave emphasis and references into prose without leaving the editor.",
      "## What you can format",
      "Use short paragraphs to keep things scannable. Break ideas apart so readers can skim before they commit to reading.",
      [
        "- Unordered lists for grouped, non-sequential points",
        "- Mix **bold** items with plain ones to highlight the important bits",
        "- Keep each bullet to a single idea",
      ].join("\n"),
      "### When order matters",
      [
        "1. Start with the outcome you want",
        "2. Describe the steps in the order a reader should follow",
        "3. End with a link to [learn more](https://example.com/docs)",
      ].join("\n"),
      "Use rich text for long-form content — essays, documentation, changelogs, or anywhere a grid of cards would feel too rigid."
    ].join("\n\n")
  }
}
