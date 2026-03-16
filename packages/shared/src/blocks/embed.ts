import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Embed", {
  schema: z.object({
    embedType: z.enum(["youtube", "vimeo", "map", "custom"]).default("youtube"),
    url: z.string().min(1),
    title: z.string().optional(),
    aspectRatio: z.enum(["16:9", "4:3", "1:1"]).default("16:9"),
  }),
  meta: {
    displayName: "Embed",
    description: "Embed external content — YouTube, Vimeo, Google Maps, or a custom iframe.",
    category: "media",
    fields: {
      embedType: { kind: "enum", label: "Embed type", options: ["youtube", "vimeo", "map", "custom"], inlineEditable: false },
      url: f.url("URL"),
      title: f.text("Title / caption"),
      aspectRatio: { kind: "enum", label: "Aspect ratio", options: ["16:9", "4:3", "1:1"], inlineEditable: false },
    },
  }
})

export function embedDefaultProps(): Record<string, unknown> {
  return {
    embedType: "youtube",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "",
    aspectRatio: "16:9",
  }
}
