import { defineType } from "sanity"

export const footerSchema = defineType({
  name: "footer",
  title: "Footer",
  type: "document",
  fields: [
    {
      name: "copyright",
      title: "Copyright text",
      type: "string",
    },
    {
      name: "columns",
      title: "Footer columns",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "title", title: "Column title", type: "string" },
        { name: "links", title: "Links (one label|url per line)", type: "text" }
          ],
        },
      ],
    }
  ],
})
