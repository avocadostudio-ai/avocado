import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Banner", {
  schema: z.object({
    text: z.string().min(1),
    variant: z.enum(["info", "success", "warning"]).default("info"),
    ctaText: z.string().optional(),
    ctaHref: z.string().optional(),
  }),
  meta: {
    displayName: "Banner",
    description: "Full-width announcement or alert bar with optional call-to-action button.",
    category: "content",
    fields: {
      text: f.text("Banner text"),
      variant: { kind: "enum", label: "Variant", options: ["info", "success", "warning"], inlineEditable: false },
      ctaText: f.text("Button label"),
      ctaHref: f.url("Button link"),
    },
  }
})

export function bannerDefaultProps(): Record<string, unknown> {
  return {
    text: "We just launched something new — check it out!",
    variant: "info",
    ctaText: "Learn more",
    ctaHref: "/",
  }
}
