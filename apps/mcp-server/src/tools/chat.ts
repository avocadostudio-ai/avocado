import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

export function registerChatTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-chat-plan",
    "High-level shortcut: send a natural-language instruction (e.g. 'make the hero bolder, add a pricing section') to the planner. The orchestrator figures out which ops to apply and runs them. Use this when you don't want to hand-craft individual block edits.",
    {
      message: z.string().min(1).describe("Natural-language edit instruction."),
      slug: z.string().optional().describe("Focus the planner on a specific page (defaults to the home page)."),
      locale: z.enum(["en", "de"]).optional().describe("Language for the planner's summary/change-log response."),
      activeBlockId: z.string().optional().describe("Hint: which block the user is currently focused on."),
    },
    async (args) => {
      try {
        return jsonResult(await client.request("POST", "/chat", { body: client.scopedBody(args) }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
