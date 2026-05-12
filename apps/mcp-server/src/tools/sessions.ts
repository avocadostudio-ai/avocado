import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

/**
 * Session introspection tools — answer "which draft am I editing?" and "what
 * other sessions exist on this orchestrator?" without dropping to raw SQLite.
 */
export function registerSessionTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-whoami",
    "Return this MCP install's bound session + a summary of its state (siteId, draft page count, version, last mutation). Useful at the start of a conversation to confirm which draft you're editing before running destructive ops.",
    {},
    async () => {
      try {
        const bound = {
          session: client.config.session,
          siteId: client.config.siteId,
          orchestratorUrl: client.config.orchestratorUrl,
        }
        const summary = await client.whoami()
        // Prefer the server-reported orchestratorUrl (strips trailing slashes, reflects the actual host),
        // but surface the locally configured session/siteId so mismatches are debuggable.
        return jsonResult({ ...summary, bound })
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-list-sessions",
    "List every session this orchestrator has state for, sorted by most recently mutated. Each row: { sessionKey, session, siteId, version, draftPageCount, lastMutatedAt }. Use to discover other drafts (e.g. {siteId}::{session} style keys) without shelling into SQLite.",
    {},
    async () => {
      try {
        return jsonResult(await client.listSessions())
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
