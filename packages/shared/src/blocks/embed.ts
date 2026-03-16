import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Embed", {
  schema: z.object({
    embedType: z.enum(["map", "social", "custom"]).default("map"),
    url: z.string().min(1),
    title: z.string().optional(),
    aspectRatio: z.enum(["16:9", "4:3", "1:1"]).default("16:9"),
  }),
  meta: {
    displayName: "Embed",
    description: "Embed external content — Google Maps, social media posts, or a custom iframe. For video use the Video block instead.",
    category: "media",
    fields: {
      embedType: { kind: "enum", label: "Embed type", options: ["map", "social", "custom"], inlineEditable: false },
      url: f.url("URL"),
      title: f.text("Title / caption"),
      aspectRatio: { kind: "enum", label: "Aspect ratio", options: ["16:9", "4:3", "1:1"], inlineEditable: false },
    },
  }
})

export function embedDefaultProps(): Record<string, unknown> {
  return {
    embedType: "map",
    url: "https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3153.0!2d-122.4194!3d37.7749!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zMzfCsDQ2JzI5LjYiTiAxMjLCsDI1JzA5LjgiVw!5e0!3m2!1sen!2sus!4v1",
    title: "",
    aspectRatio: "16:9",
  }
}
