import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Video", {
  schema: z.object({
    src: z.string().min(1),
    title: z.string().optional(),
    posterUrl: z.string().optional(),
    autoplay: z.enum(["true", "false"]).default("false"),
    loop: z.enum(["true", "false"]).default("false"),
  }),
  meta: {
    displayName: "Video",
    description: "Video player — supports YouTube, Vimeo URLs, or direct video files (mp4, webm). Auto-detects source type.",
    category: "media",
    fields: {
      src: f.url("Video URL"),
      title: f.text("Title / caption"),
      posterUrl: f.image("Poster image", { aspectRatio: "landscape", width: 1200, height: 675 }),
      autoplay: { kind: "enum", label: "Autoplay", options: ["true", "false"], inlineEditable: false },
      loop: { kind: "enum", label: "Loop", options: ["true", "false"], inlineEditable: false },
    },
  }
})

export function videoDefaultProps(): Record<string, unknown> {
  return {
    src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "",
    posterUrl: "",
    autoplay: "false",
    loop: "false",
  }
}
