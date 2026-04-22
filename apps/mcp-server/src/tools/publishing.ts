import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

export function registerPublishingTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-compute-publish-diff",
    "Compute the diff between the current draft and the last published snapshot. Shows what would change if you publish now.",
    {
      siteOrigin: z.string().url().optional().describe("Override the published-content source (defaults to the configured site origin)."),
    },
    async ({ siteOrigin }) => {
      try {
        return jsonResult(await client.request("GET", "/publish/diff", {
          query: client.scoped({ siteOrigin }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-publish-content",
    "Publish the current draft to the live site. Requires AVOCADO_PUBLISH_TOKEN env var (the orchestrator's DRAFT_MODE_SECRET) to be set on the MCP server process.",
    {
      siteOrigin: z.string().url().optional(),
    },
    async ({ siteOrigin }) => {
      if (!client.config.publishToken) {
        return errorResult(new Error("AVOCADO_PUBLISH_TOKEN is not set on the MCP server. Re-install the connector with --env AVOCADO_PUBLISH_TOKEN=<DRAFT_MODE_SECRET>."))
      }
      try {
        return jsonResult(await client.request("POST", "/publish", {
          body: client.scopedBody({ siteOrigin }),
          bearer: client.config.publishToken,
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-get-publish-status",
    "Fetch the current publish tracker for this site (target type, state, last deployment, URLs).",
    {},
    async () => {
      try {
        return jsonResult(await client.request("GET", "/publish/status", { query: client.scoped() }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-list-snapshots",
    "List published snapshots (prior publish commits) available to restore from. Defaults to the latest 30.",
    {
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ limit }) => {
      try {
        return jsonResult(await client.request("GET", "/restore/snapshots", {
          query: { siteId: client.config.siteId, limit },
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-restore-snapshot",
    "Rewind the draft to a previously-published snapshot, identified by its git commit sha (from avocado-list-snapshots).",
    {
      commit: z.string().regex(/^[a-f0-9]{7,40}$/i).describe("Git commit sha (7–40 hex chars) of the published snapshot."),
    },
    async ({ commit }) => {
      try {
        return jsonResult(await client.request("POST", "/restore/snapshot", {
          body: client.scopedBody({ commit }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
