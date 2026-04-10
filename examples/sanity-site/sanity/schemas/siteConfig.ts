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
      name: "purpose",
      title: "Purpose",
      description: "What the site is about — used as AI context for editing.",
      type: "text",
    }),
    defineField({
      name: "tone",
      title: "Tone",
      description: "Voice/tone guide for AI-generated content.",
      type: "text",
    }),
    defineField({
      name: "constraints",
      title: "Constraints",
      description: "Content rules the AI must follow.",
      type: "array",
      of: [{ type: "string" }],
    }),
    defineField({
      name: "navLabels",
      title: "Nav Labels",
      description: "Custom navigation labels per slug (e.g., /pricing → Plans & Pricing).",
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
    defineField({
      name: "navGroups",
      title: "Nav Groups",
      description: "Grouped navigation (parent label → child slugs).",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            { name: "label", title: "Label", type: "string" },
            { name: "slugs", title: "Slugs", type: "array", of: [{ type: "string" }] },
          ],
        },
      ],
    }),
    defineField({
      name: "themeOverrides",
      title: "Theme Overrides",
      description: "CSS variable overrides (e.g., --brand → #2563eb).",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            { name: "key", title: "Key", type: "string" },
            { name: "value", title: "Value", type: "string" },
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
