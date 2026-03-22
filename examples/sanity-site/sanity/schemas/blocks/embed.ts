import { defineType } from "sanity"

export const embedSchema = defineType({
  name: "embed",
  title: "Embed",
  type: "document",
  fields: [
    {
      name: "embedType",
      title: "Embed type",
      type: "string",
      options: {
        list: ["map", "social", "custom"],
      },
    },
    {
      name: "url",
      title: "URL",
      type: "string",
    },
    {
      name: "title",
      title: "Title / caption",
      type: "string",
    },
    {
      name: "aspectRatio",
      title: "Aspect ratio",
      type: "string",
      options: {
        list: ["16:9", "4:3", "1:1"],
      },
    }
  ],
})
