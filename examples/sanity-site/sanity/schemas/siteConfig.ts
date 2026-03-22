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
      type: "object",
      fields: [],
    }),
  ],
  preview: {
    select: { title: "name" },
    prepare({ title }) {
      return { title: title ?? "Site Config" }
    },
  },
})
