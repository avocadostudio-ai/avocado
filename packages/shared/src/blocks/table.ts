import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

registerBlock("Table", {
  schema: z.object({
    title: z.string().optional(),
    headingLevel: z.string().optional(),
    headers: z.array(z.string().min(1)).min(1),
    rows: z.array(z.array(z.coerce.string())).min(1),
    striped: z.enum(["true", "false"]).default("false"),
  }),
  meta: {
    displayName: "Table",
    description: "Data table with column headers, rows, and optional stripe styling. Headers is a string array. Rows is a 2D string array where each inner array is one row matching the headers order.",
    category: "content",
    fields: {
      title: f.text("Section title"),
      headingLevel: f.headingLevel(),
      headers: f.text("Column headers"),
      rows: f.text("Table rows"),
      striped: { kind: "enum", label: "Striped rows", options: ["true", "false"], inlineEditable: false },
    },
  }
})

export function tableDefaultProps(): Record<string, unknown> {
  return {
    title: "",
    headers: ["Feature", "Starter", "Pro", "Enterprise"],
    rows: [
      ["Users", "Up to 3", "Up to 20", "Unlimited"],
      ["Storage", "1 GB", "10 GB", "100 GB"],
      ["Support", "Community", "Email", "Dedicated"],
      ["API access", "—", "Yes", "Yes"],
    ],
    striped: "true",
  }
}
