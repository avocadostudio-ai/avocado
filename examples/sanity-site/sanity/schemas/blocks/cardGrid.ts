import { defineType } from "sanity"

export const cardGridSchema = defineType({
  name: "cardGrid",
  title: "Card Grid",
  type: "document",
  fields: [
    {
      name: "title",
      title: "Section title",
      type: "string",
    },
    {
      name: "subtitle",
      title: "Subtitle",
      type: "string",
    },
    {
      name: "cards",
      title: "Cards",
      type: "array",
      of: [{ type: "reference", to: [{ type: "card" }] }],
    }
  ],
})
