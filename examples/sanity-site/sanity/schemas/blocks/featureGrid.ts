import { defineType } from "sanity"

export const featureGridSchema = defineType({
  name: "featureGrid",
  title: "Feature Grid",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "features",
      title: "Features",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "title", title: "Feature title", type: "string" },
        { name: "description", title: "Feature description", type: "string" }
          ],
        },
      ],
    }
  ],
})
