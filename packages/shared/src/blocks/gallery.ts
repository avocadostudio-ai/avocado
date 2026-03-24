import { z } from "zod"
import { registerBlock, IMAGE_PLACEHOLDER } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Gallery", {
  schema: z.object({
    title: z.string().optional(),
    headingLevel: z.string().optional(),
    columns: z.enum(["2", "3", "4"]).default("3"),
    images: z.array(z.object({
      imageUrl: z.string().min(1),
      alt: z.string().optional(),
      caption: z.string().optional(),
    })).min(1),
  }),
  meta: {
    displayName: "Gallery",
    description: "Image grid with configurable columns and optional captions.",
    category: "media",
    fields: {
      title: f.text("Section title"),
      columns: { kind: "enum", label: "Columns", options: ["2", "3", "4"], inlineEditable: false },
      headingLevel: f.headingLevel(),
    },
    listFields: {
      images: {
        label: "Images",
        itemFields: {
          imageUrl: f.image("Image", { aspectRatio: "landscape", width: 800, height: 600 }),
          alt: f.imageAlt("Alt text"),
          caption: f.text("Caption"),
        }
      }
    }
  }
})

export function galleryDefaultProps(): Record<string, unknown> {
  return {
    title: "",
    columns: "3",
    images: [
      { imageUrl: IMAGE_PLACEHOLDER, alt: "Gallery image 1", caption: "" },
      { imageUrl: IMAGE_PLACEHOLDER, alt: "Gallery image 2", caption: "" },
      { imageUrl: IMAGE_PLACEHOLDER, alt: "Gallery image 3", caption: "" },
    ],
  }
}
