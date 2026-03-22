import { defineType } from "sanity"

export const ctaSchema = defineType({
  name: "cta",
  title: "Call to Action",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Headline",
      type: "string",
    },
    {
      name: "description",
      title: "Description",
      type: "string",
    },
    {
      name: "ctaText",
      title: "Button text",
      type: "string",
    },
    {
      name: "ctaHref",
      title: "Button link",
      type: "url",
    }
  ],
})
