import { z } from "zod"
import { registerBlock } from "@ai-site-editor/shared"

registerBlock("PricingTable", {
  schema: z.object({
    title: z.string().min(1),
    footnote: z.string().optional(),
    tiers: z.array(
      z.object({
        duration: z.string().min(1),
        days: z.string().min(1),
        price: z.string().min(1),
        isSpecial: z.boolean().optional(),
        features: z.array(z.string()).min(1),
      })
    ).min(1),
  }),
  meta: {
    displayName: "Pricing Table",
    description: "4-column pricing tiers for a paintball arena with duration, price, features list, and optional SPEZIALPREIS badge.",
    category: "conversion",
    fields: {
      title: { kind: "text", label: "Section heading" },
      footnote: { kind: "text", label: "Footnote below all cards", multiline: false },
    },
    listFields: {
      tiers: {
        label: "Pricing Tiers",
        itemFields: {
          duration: { kind: "text", label: "Duration (e.g. 3h)" },
          days: { kind: "text", label: "Days / time info" },
          price: { kind: "text", label: "Price (e.g. 79.- / Person)" },
          isSpecial: { kind: "enum", label: "Show SPEZIALPREIS badge", options: ["true", "false"], inlineEditable: false },
          features: { kind: "text", label: "Features (one per item)" },
        },
      },
    },
  },
})

export function pricingTableDefaultProps(): Record<string, unknown> {
  return {
    title: "UNSERE PREISE",
    footnote: "* Preise inkl. MwSt. Gruppenrabatte auf Anfrage.",
    tiers: [
      {
        duration: "2h",
        days: "Mo, Di, Do",
        price: "59.- / Person",
        isSpecial: false,
        features: ["Schutzausrüstung", "100 Paintballs", "Spielleitung"],
      },
      {
        duration: "3h",
        days: "Mo, Di, Do & Sa",
        price: "79.- / Person",
        isSpecial: true,
        features: ["Schutzausrüstung", "200 Paintballs", "Spielleitung", "2 Felder"],
      },
      {
        duration: "4h",
        days: "Fr, Sa & So",
        price: "99.- / Person",
        isSpecial: false,
        features: ["Schutzausrüstung", "300 Paintballs", "Spielleitung", "3 Felder", "Getränk"],
      },
      {
        duration: "6h",
        days: "Sa & So",
        price: "149.- / Person",
        isSpecial: false,
        features: ["Schutzausrüstung", "500 Paintballs", "Spielleitung", "Alle Felder", "Getränke", "Snacks"],
      },
    ],
  }
}
