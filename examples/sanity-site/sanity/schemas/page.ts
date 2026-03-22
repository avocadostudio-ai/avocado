import { defineType, defineField } from "sanity"
import { blockSchemas } from "./blocks"

export const pageSchema = defineType({
  name: "page",
  title: "Page",
  type: "document",
  fields: [
    defineField({
      name: "slug",
      title: "Slug",
      type: "slug",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "title",
      title: "Title",
      type: "string",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: "pageId",
      title: "Page ID",
      type: "string",
    }),
    defineField({
      name: "blocks",
      title: "Blocks",
      type: "array",
      of: [
        {
          type: "reference",
          to: blockSchemas.map((schema) => ({ type: schema.name })),
        },
      ],
    }),
    defineField({
      name: "meta",
      title: "Meta",
      type: "object",
      fields: [
        { name: "title", title: "Page title", type: "string" },
        { name: "description", title: "Description", type: "text" },
        { name: "ogImage", title: "OG Image URL", type: "url" },
      ],
    }),
  ],
  preview: {
    select: { title: "title", slug: "slug.current" },
    prepare({ title, slug }) {
      return { title: title ?? "Untitled", subtitle: slug ?? "/" }
    },
  },
})
