import { defineType } from "sanity"

export const siteHeaderSchema = defineType({
  name: "siteHeader",
  title: "Site Header",
  type: "document",
  fields: [
    {
      name: "siteName",
      title: "Site name",
      type: "string",
    },
    {
      name: "logoUrl",
      title: "Logo",
      type: "image",
    },
    {
      name: "links",
      title: "Nav links",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "label", title: "Link label", type: "string" },
        { name: "href", title: "Link URL", type: "url" }
          ],
        },
      ],
    }
  ],
})
