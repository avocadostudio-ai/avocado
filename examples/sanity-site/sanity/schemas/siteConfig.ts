import { defineType, defineField } from "sanity"

export const siteConfigSchema = defineType({
  name: "siteConfig",
  title: "Site Config",
  type: "document",
  fields: [
    defineField({
      name: "name",
      title: "Site Name",
      type: "string",
    }),
    defineField({
      name: "logo",
      title: "Logo URL",
      type: "string",
    }),
    defineField({
      name: "navLabels",
      title: "Nav Labels",
      description: "Custom navigation labels per slug (e.g., /pricing → Plans & Pricing)",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            { name: "slug", title: "Slug", type: "string" },
            { name: "label", title: "Label", type: "string" },
          ],
        },
      ],
    }),
  ],
  preview: {
    select: { title: "name" },
    prepare({ title }) {
      return { title: title ?? "Site Config" }
    },
  },
})
