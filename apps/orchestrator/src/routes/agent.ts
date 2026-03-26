/**
 * Agent route: POST /agent/chat (non-SSE, returns full result)
 *
 * For the PoC, we use a simple POST that waits for the full agent loop
 * to complete and returns the result as JSON. SSE streaming can be added
 * later using the start/stream pattern from chat routes.
 */

import type { FastifyInstance } from "fastify"
import { scopedSessionKey } from "../state/session-state.js"
import { createAgentTools } from "../agent/agent-tools.js"
import { buildAgentSystemPrompt, buildContextMessage } from "../agent/agent-context.js"
import { runAgentLoop, type AgentEvent } from "../agent/agent-loop.js"

type AgentChatBody = {
  session?: string
  siteId?: string
  slug?: string
  message?: string
  model?: string
  locale?: string
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  sitePurpose?: string
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.post("/agent/chat", async (request, reply) => {
    const apiKey = (request.headers["x-anthropic-api-key"] as string)?.trim()
    if (!apiKey) {
      return reply.code(401).send({ error: "X-Anthropic-API-Key header required" })
    }

    const body = request.body as AgentChatBody
    const sessionRaw = body.session ?? "dev"
    const siteId = body.siteId ?? ""
    const slug = body.slug ?? "/"
    const message = body.message?.trim()

    if (!message) return reply.code(400).send({ error: "message is required" })
    if (!siteId) return reply.code(400).send({ error: "siteId is required" })

    const session = scopedSessionKey(sessionRaw, siteId)
    const tools = createAgentTools(session)
    const systemPrompt = buildAgentSystemPrompt({ locale: body.locale, sitePurpose: body.sitePurpose })
    const contextMsg = buildContextMessage(session, { slug, activeBlockId: body.activeBlockId, activeEditablePath: body.activeEditablePath })
    const fullMessage = `${contextMsg}\n\n---\n\nUser request: ${message}`

    // Collect all events from the agent loop
    const events: AgentEvent[] = []
    let summary = ""
    let toolCallCount = 0
    let error: string | null = null

    try {
      for await (const event of runAgentLoop({
        apiKey,
        model: body.model,
        systemPrompt,
        tools,
        userMessage: fullMessage,
      })) {
        events.push(event)
        if (event.type === "done") {
          summary = event.summary
          toolCallCount = event.toolCallCount
        }
        if (event.type === "error") {
          error = event.message
        }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (error) {
      return reply.code(500).send({ status: "error", error, events })
    }

    return {
      status: "applied",
      summary,
      toolCallCount,
      events: events.map(e => {
        if (e.type === "tool_done") return { type: e.type, toolName: e.toolName, isError: e.isError }
        if (e.type === "tool_start") return { type: e.type, toolName: e.toolName }
        if (e.type === "text_delta") return { type: e.type, text: e.text }
        return e
      }),
    }
  })
}
