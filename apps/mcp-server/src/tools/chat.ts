import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

const message = z.string().min(1).describe("Natural-language edit instruction.")
const slug = z.string().optional().describe("Focus the planner on a specific page (defaults to the home page).")
const locale = z.enum(["en", "de"]).optional().describe("Language for the planner's summary/change-log response.")
const activeBlockId = z.string().optional().describe("Hint: which block the user is currently focused on.")

export function registerChatTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-chat-plan",
    "High-level shortcut: send a natural-language instruction to the planner. The orchestrator decides whether to apply directly or surface a pending plan for approval. Response may contain a `pendingPlanId` — if so, call avocado-approve-pending-plan or avocado-discard-pending-plan next.",
    { message, slug, locale, activeBlockId },
    async (args) => {
      try {
        return jsonResult(await client.request("POST", "/chat", { body: client.scopedBody(args) }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-preview-plan",
    "Run the planner in plan-only mode: the orchestrator returns the would-apply ops without mutating draft state. Use this to review a plan before approving. The response includes a `pendingPlanId` you can then pass to avocado-approve-pending-plan.",
    { message, slug, locale, activeBlockId },
    async (args) => {
      try {
        return jsonResult(await client.request("POST", "/chat", {
          body: client.scopedBody({ ...args, executionMode: "plan_only" }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-approve-pending-plan",
    "Apply the pending plan that's waiting for approval on the current session. Pass `pendingPlanId` from the prior chat response to protect against race conditions (the orchestrator rejects stale approvals).",
    {
      pendingPlanId: z.string().optional().describe("Id from the prior chat response's pendingPlanId field. Omit to apply whatever is pending (risky)."),
    },
    async ({ pendingPlanId }) => {
      try {
        return jsonResult(await client.request("POST", "/chat", {
          body: client.scopedBody({ message: "approve", executionMode: "apply_pending_plan", pendingPlanId }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-discard-pending-plan",
    "Discard the pending plan waiting for approval on the current session (user rejected the proposal). Clears orchestrator-side state.",
    {},
    async () => {
      try {
        return jsonResult(await client.request("POST", "/chat", {
          body: client.scopedBody({ message: "discard", executionMode: "discard_pending_plan" }),
        }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
