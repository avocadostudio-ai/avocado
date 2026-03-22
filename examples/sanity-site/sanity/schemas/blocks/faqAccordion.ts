import { defineType } from "sanity"

export const faqAccordionSchema = defineType({
  name: "faqAccordion",
  title: "FAQ Accordion",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "items",
      title: "FAQ items",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "q", title: "Question", type: "string" },
        { name: "a", title: "Answer", type: "string" }
          ],
        },
      ],
    }
  ],
})
