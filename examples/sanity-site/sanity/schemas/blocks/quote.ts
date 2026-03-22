import { defineType } from "sanity"

export const quoteSchema = defineType({
  name: "quote",
  title: "Quote",
  type: "document",
  fields: [
    {
      name: "quote",
      title: "Quote text",
      type: "text",
    },
    {
      name: "author",
      title: "Author name",
      type: "string",
    },
    {
      name: "role",
      title: "Author role / title",
      type: "string",
    },
    {
      name: "imageUrl",
      title: "Author avatar",
      type: "image",
    },
    {
      name: "imageAlt",
      title: "Avatar alt text",
      type: "string",
    }
  ],
})
