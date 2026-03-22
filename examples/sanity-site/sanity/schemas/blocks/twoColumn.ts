import { defineType } from "sanity"

export const twoColumnSchema = defineType({
  name: "twoColumn",
  title: "Two Column",
  type: "document",
  fields: [
    {
      name: "variant",
      title: "Style variant",
      type: "string",
      options: {
        list: ["default", "accent"],
      },
    },
    {
      name: "left",
      title: "Left column items",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "type", title: "Component type", type: "string" },
        { name: "text", title: "Text content", type: "string" },
        { name: "label", title: "Button label", type: "string" },
        { name: "href", title: "Link URL", type: "string" },
        { name: "src", title: "Media source", type: "image" },
        { name: "alt", title: "Alt text", type: "string" },
        { name: "poster", title: "Video poster image", type: "image" }
          ],
        },
      ],
    },
    {
      name: "right",
      title: "Right column items",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "type", title: "Component type", type: "string" },
        { name: "text", title: "Text content", type: "string" },
        { name: "label", title: "Button label", type: "string" },
        { name: "href", title: "Link URL", type: "string" },
        { name: "src", title: "Media source", type: "image" },
        { name: "alt", title: "Alt text", type: "string" },
        { name: "poster", title: "Video poster image", type: "image" }
          ],
        },
      ],
    }
  ],
})
