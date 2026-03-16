import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Quote", {
  schema: z.object({
    quote: z.string().min(1),
    author: z.string().optional(),
    role: z.string().optional(),
    imageUrl: z.string().optional(),
  }),
  meta: {
    displayName: "Quote",
    description: "Pull quote or blockquote with optional author attribution and avatar.",
    category: "content",
    fields: {
      quote: f.richtext("Quote text"),
      author: f.text("Author name"),
      role: f.text("Author role / title"),
      imageUrl: f.image("Author avatar", { aspectRatio: "square", width: 128, height: 128 }),
    },
  }
})

export function quoteDefaultProps(): Record<string, unknown> {
  return {
    quote: "The best way to predict the future is to create it.",
    author: "Peter Drucker",
    role: "Management Consultant",
    imageUrl: "https://i.pravatar.cc/300",
  }
}
