import { defineType } from "sanity"

export const statsSchema = defineType({
  name: "stats",
  title: "Stats",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "stats",
      title: "Stats",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "value", title: "Value", type: "string" },
        { name: "label", title: "Label", type: "string" }
          ],
        },
      ],
    }
  ],
})
