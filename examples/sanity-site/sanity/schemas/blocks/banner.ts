import { defineType } from "sanity"

export const bannerSchema = defineType({
  name: "banner",
  title: "Banner",
  type: "document",
  fields: [
    {
      name: "text",
      title: "Banner text",
      type: "string",
    },
    {
      name: "variant",
      title: "Variant",
      type: "string",
      options: {
        list: ["info", "success", "warning"],
      },
    },
    {
      name: "ctaText",
      title: "Button label",
      type: "string",
    },
    {
      name: "ctaHref",
      title: "Button link",
      type: "url",
    }
  ],
})
