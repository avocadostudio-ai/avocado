import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

const slug = z.string().min(1).describe("Page slug to undo/redo (history is per-page).")

export function registerHistoryTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-undo-edit",
    "Undo the last change on a page. Returns the new preview version and whether further undo/redo is available.",
    { slug },
    async ({ slug }) => {
      try {
        return jsonResult(await client.request("POST", "/history/undo", {
          body: client.scopedBody({ slug }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-redo-edit",
    "Redo the most recently-undone change on a page.",
    { slug },
    async ({ slug }) => {
      try {
        return jsonResult(await client.request("POST", "/history/redo", {
          body: client.scopedBody({ slug }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-restore-version",
    "Jump to a specific version number from the history log (does not consume undo/redo stacks). Current state is pushed to undo first.",
    {
      targetVersion: z.number().int().positive().describe("Version number from the history log."),
    },
    async ({ targetVersion }) => {
      try {
        return jsonResult(await client.request("POST", "/history/restore", {
          body: client.scopedBody({ targetVersion }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
