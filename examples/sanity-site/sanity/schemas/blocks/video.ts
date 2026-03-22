import { defineType } from "sanity"

export const videoSchema = defineType({
  name: "video",
  title: "Video",
  type: "document",
  fields: [
    {
      name: "src",
      title: "Video URL",
      type: "url",
    },
    {
      name: "title",
      title: "Title / caption",
      type: "string",
    },
    {
      name: "posterUrl",
      title: "Poster image",
      type: "image",
    },
    {
      name: "autoplay",
      title: "Autoplay",
      type: "string",
      options: {
        list: ["true", "false"],
      },
    },
    {
      name: "loop",
      title: "Loop",
      type: "string",
      options: {
        list: ["true", "false"],
      },
    }
  ],
})
