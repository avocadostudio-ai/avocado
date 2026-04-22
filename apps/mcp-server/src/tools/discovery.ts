import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
// Side-effect import: registers every built-in block schema + meta.
import "@ai-site-editor/shared/src/blocks/index.ts"
import { getAllBlockMeta, getBlockJsonSchema } from "@ai-site-editor/shared"

/** Read-only tools that help agents discover what they can edit. */
export function registerDiscoveryTools(server: McpServer) {
  server.tool(
    "avocado-list-block-types",
    "List every block type Avocado Studio can render (name, category, description). Call this before constructing add-block ops so you know which types exist.",
    {},
    async () => {
      const meta = getAllBlockMeta()
      const entries = Object.entries(meta).map(([type, m]) => ({
        type,
        displayName: m.displayName,
        category: m.category ?? null,
        description: m.description ?? null,
        chrome: m.chrome === true,
      }))
      return { content: [{ type: "text" as const, text: JSON.stringify({ blockTypes: entries }, null, 2) }] }
    }
  )

  server.tool(
    "avocado-get-block-schema",
    "Return the JSON schema + field metadata for a block type. Call this before add-block or update-block-props so you know the exact prop shape (required keys, enum options, list item fields, image aspect ratios).",
    {
      type: z.string().describe("Block type name (e.g. 'Hero', 'CTA', 'FeatureGrid')."),
    },
    async ({ type }) => {
      const meta = getAllBlockMeta()[type]
      if (!meta) {
        return {
          content: [{ type: "text" as const, text: `Unknown block type: ${type}. Call avocado-list-block-types to see valid types.` }],
          isError: true,
        }
      }
      const jsonSchema = getBlockJsonSchema(type)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ type, meta, jsonSchema }, null, 2),
          },
        ],
      }
    }
  )
}
