import { defineType } from "sanity"

export const tabsSchema = defineType({
  name: "tabs",
  title: "Tabs",
  type: "document",
  fields: [
    {
      name: "tabs",
      title: "Tabs",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "label", title: "Tab label", type: "string" },
        { name: "content", title: "Tab content", type: "text" }
          ],
        },
      ],
    }
  ],
})
