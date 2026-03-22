import { defineType } from "sanity"

export const cardSchema = defineType({
  name: "card",
  title: "Card",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Card title",
      type: "string",
    },
    {
      name: "description",
      title: "Card description",
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
      type: "string",
    },
    {
      name: "imageUrl",
      title: "Card image",
      type: "image",
    },
    {
      name: "imageAlt",
      title: "Card image alt text",
      type: "string",
    }
  ],
})
