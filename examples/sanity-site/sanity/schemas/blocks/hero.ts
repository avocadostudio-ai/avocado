import { defineType } from "sanity"

export const heroSchema = defineType({
  name: "hero",
  title: "Hero",
  type: "document",
  fields: [
    {
      name: "heading",
      title: "Heading",
      type: "string",
    },
    {
      name: "subheading",
      title: "Subheading",
      type: "string",
    },
    {
      name: "ctaText",
      title: "CTA button text",
      type: "string",
    },
    {
      name: "ctaHref",
      title: "CTA link",
      type: "string",
    },
    {
      name: "imageUrl",
      title: "Hero image",
      type: "image",
    },
    {
      name: "imageAlt",
      title: "Hero image alt text",
      type: "string",
    },
    {
      name: "imagePosition",
      title: "Image position",
      type: "string",
      options: {
        list: ["left", "right"],
      },
    },
    {
      name: "secondaryCtaText",
      title: "Secondary CTA text",
      type: "string",
    },
    {
      name: "secondaryCtaHref",
      title: "Secondary CTA link",
      type: "string",
    }
  ],
})
