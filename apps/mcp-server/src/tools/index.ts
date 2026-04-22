import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { registerDiscoveryTools } from "./discovery.ts"
import { registerPageTools } from "./pages.ts"
import { registerBlockTools } from "./blocks.ts"
import { registerSiteTools } from "./sites.ts"
import { registerMediaTools } from "./media.ts"
import { registerPublishingTools } from "./publishing.ts"
import { registerHistoryTools } from "./history.ts"
import { registerChatTools } from "./chat.ts"

export function registerAllTools(server: McpServer, client: OrchestratorClient) {
  registerDiscoveryTools(server)
  registerPageTools(server, client)
  registerBlockTools(server, client)
  registerSiteTools(server, client)
  registerMediaTools(server, client)
  registerPublishingTools(server, client)
  registerHistoryTools(server, client)
  registerChatTools(server, client)
}
