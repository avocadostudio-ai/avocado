import { defineType } from "sanity"

export const tableSchema = defineType({
  name: "table",
  title: "Table",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "headers",
      title: "Column headers",
      type: "string",
    },
    {
      name: "rows",
      title: "Table rows",
      type: "string",
    },
    {
      name: "striped",
      title: "Striped rows",
      type: "string",
      options: {
        list: ["true", "false"],
      },
    }
  ],
})
