import { defineType } from "sanity"

export const carouselSchema = defineType({
  name: "carousel",
  title: "Carousel",
  type: "document",
  fields: [
    {
      name: "autoplay",
      title: "Autoplay",
      type: "string",
      options: {
        list: ["true", "false"],
      },
    },
    {
      name: "interval",
      title: "Interval (ms)",
      type: "number",
    },
    {
      name: "items",
      title: "Slides",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "imageUrl", title: "Slide image", type: "image" },
        { name: "imageAlt", title: "Image alt text", type: "string" },
        { name: "heading", title: "Heading", type: "string" },
        { name: "description", title: "Description", type: "string" },
        { name: "ctaText", title: "Button label", type: "string" },
        { name: "ctaHref", title: "Button link", type: "url" }
          ],
        },
      ],
    }
  ],
})
