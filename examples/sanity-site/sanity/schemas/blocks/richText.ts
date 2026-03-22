import { defineType } from "sanity"

export const richTextSchema = defineType({
  name: "richText",
  title: "Rich Text",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "body",
      title: "Body",
      type: "text",
    }
  ],
})
