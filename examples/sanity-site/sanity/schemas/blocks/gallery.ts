import { defineType } from "sanity"

export const gallerySchema = defineType({
  name: "gallery",
  title: "Gallery",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "columns",
      title: "Columns",
      type: "string",
      options: {
        list: ["2", "3", "4"],
      },
    },
    {
      name: "images",
      title: "Images",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
        { name: "imageUrl", title: "Image", type: "image" },
        { name: "alt", title: "Alt text", type: "string" },
        { name: "caption", title: "Caption", type: "string" }
          ],
        },
      ],
    }
  ],
})
