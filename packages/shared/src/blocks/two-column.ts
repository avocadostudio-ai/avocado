import { z } from "zod"
import { registerBlock, type FieldMeta } from "./_registry.ts"
import { f } from "./_helpers.ts"

const twoColumnChild = z.object({
  type: z.enum(["heading", "subheading", "paragraph", "list", "cta", "ctas", "image", "video"]),
  text: z.string().optional(),
  label: z.string().optional(),
  href: z.string().optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  poster: z.string().optional(),
  items: z.array(z.string()).optional(),
  buttons: z.array(z.object({ label: z.string(), href: z.string(), variant: z.string().optional() })).optional(),
  variant: z.string().optional()
})

const twoColumnItemFields: Record<string, FieldMeta> = {
  type: { kind: "enum", label: "Component type", options: ["heading", "subheading", "paragraph", "list", "cta", "ctas", "image", "video"] },
  text: f.longtext("Text content"),
  label: f.text("Button label"),
  href: f.url("Link URL"),
  src: f.image("Media source", { aspectRatio: "portrait", width: 768, height: 1024 }),
  alt: f.imageAlt("Alt text"),
  poster: f.image("Video poster image", { aspectRatio: "landscape", width: 768, height: 512 }),
}

registerBlock("TwoColumn", {
  schema: z.object({
    variant: z.enum(["default", "accent"]).default("default"),
    left: z.array(twoColumnChild).min(1),
    right: z.array(twoColumnChild).min(1)
  }),
  meta: {
    displayName: "Two Column",
    description: "Composite two-column layout with typed child components in each column.",
    category: "layout",
    fields: {
      variant: { kind: "enum", label: "Style variant", options: ["default", "accent"], inlineEditable: false },
      headingLevel: f.headingLevel(),
    },
    listFields: {
      left: { label: "Left column items", itemFields: twoColumnItemFields },
      right: { label: "Right column items", itemFields: twoColumnItemFields }
    }
  }
})

export function twoColumnDefaultProps(): Record<string, unknown> {
  return {
    variant: "default",
    left: [
      { type: "heading", text: "Built for teams" },
      { type: "paragraph", text: "Ship changes quickly with a clear, reliable workflow." },
      { type: "cta", label: "Learn more", href: "/" }
    ],
    right: [
      { type: "image", src: "/hero-generated.svg", alt: "Team collaborating on a website update" }
    ]
  }
}
