import { defineType } from "sanity"

export const testimonialsSchema = defineType({
  name: "testimonials",
  title: "Testimonials",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "items",
      title: "Testimonials",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "quote", title: "Quote", type: "string" },
        { name: "author", title: "Author", type: "string" }
          ],
        },
      ],
    }
  ],
})
