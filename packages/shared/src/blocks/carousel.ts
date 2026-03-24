import { z } from "zod"
import { registerBlock, IMAGE_PLACEHOLDER } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Carousel", {
  schema: z.object({
    items: z.array(z.object({
      imageUrl: z.string().min(1),
      imageAlt: z.string().optional(),
      heading: z.string().optional(),
      description: z.string().optional(),
      ctaText: z.string().optional(),
      ctaHref: z.string().optional(),
    })).min(1),
    autoplay: z.enum(["true", "false"]).default("false"),
    interval: z.number().optional(),
  }),
  meta: {
    displayName: "Carousel",
    description: "Image/content slideshow with prev/next navigation and dot indicators.",
    category: "content",
    fields: {
      autoplay: { kind: "enum", label: "Autoplay", options: ["true", "false"], inlineEditable: false },
      interval: { kind: "number", label: "Interval (ms)", inlineEditable: false },
    },
    listFields: {
      items: {
        label: "Slides",
        itemFields: {
          imageUrl: f.image("Slide image", { aspectRatio: "landscape", width: 1200, height: 600 }),
          imageAlt: f.imageAlt("Image alt text"),
          heading: f.text("Heading"),
          description: f.longtext("Description"),
          ctaText: f.text("Button label"),
          ctaHref: f.url("Button link"),
        }
      }
    }
  }
})

export function carouselDefaultProps(): Record<string, unknown> {
  return {
    items: [
      { imageUrl: IMAGE_PLACEHOLDER, imageAlt: "First slide", heading: "Welcome", description: "Get started with our platform.", ctaText: "Get started", ctaHref: "/" },
      { imageUrl: IMAGE_PLACEHOLDER, imageAlt: "Second slide", heading: "Features", description: "Discover what makes us different." },
      { imageUrl: IMAGE_PLACEHOLDER, imageAlt: "Third slide", heading: "Get Started", description: "Sign up today and start building.", ctaText: "Sign up", ctaHref: "/pricing" },
    ],
    autoplay: "false",
    interval: 5000,
  }
}
