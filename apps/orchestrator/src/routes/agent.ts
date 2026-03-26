/**
 * Agent route: /agent/chat
 *
 * Accepts a user message + Anthropic API key, runs the agent loop,
 * and streams SSE events back to the client.
 */

import type { FastifyInstance } from "fastify"
import { scopedSessionKey } from "../state/session-state.js"
import { createAgentTools } from "../agent/agent-tools.js"
import { buildAgentSystemPrompt, buildContextMessage } from "../agent/agent-context.js"
import { runAgentLoop } from "../agent/agent-loop.js"
import { sseWrite } from "../chat/chat-pipeline-shared.js"

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

    if (!message) {
      return reply.code(400).send({ error: "message is required" })
    }
    if (!siteId) {
      return reply.code(400).send({ error: "siteId is required" })
    }

    const session = scopedSessionKey(sessionRaw, siteId)

    // Build tools and context
    const tools = createAgentTools(session)
    const systemPrompt = buildAgentSystemPrompt({
      locale: body.locale,
      sitePurpose: body.sitePurpose,
    })
    const contextMessage = buildContextMessage(session, {
      slug,
      activeBlockId: body.activeBlockId,
      activeEditablePath: body.activeEditablePath,
    })
    const fullMessage = `${contextMessage}\n\n---\n\nUser request: ${message}`

    const reqOrigin = (request.headers.origin as string) ?? "*"
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no")
    reply.raw.setHeader("Access-Control-Allow-Origin", reqOrigin)
    reply.raw.setHeader("Vary", "Origin")
    reply.raw.write("retry: 60000\n\n")

    let seq = 0
    const emit = (data: Record<string, unknown>) => {
      seq++
      sseWrite(reply, { ...data, _seq: seq })
    }

    emit({ type: "status", message: "Agent starting..." })

    try {
      console.log("[agent] Starting loop with model:", body.model ?? "default")
      const agentLoop = runAgentLoop({
        apiKey,
        model: body.model,
        systemPrompt,
        tools,
        userMessage: fullMessage,
      })

      for await (const event of agentLoop) {
        if (request.raw.destroyed) break

        switch (event.type) {
          case "text_delta":
            emit({ type: "summary_token", text: event.text })
            break
          case "tool_start":
            emit({ type: "status", message: `Using ${event.toolName}...` })
            break
          case "tool_done":
            if (!event.isError) {
              try {
                const parsed = JSON.parse(event.result)
                if (parsed.status === "applied") {
                  emit({
                    type: "op_applied",
                    toolName: event.toolName,
                    previewVersion: parsed.previewVersion,
                    appliedCount: parsed.appliedCount,
                  })
                }
              } catch {
                // Non-JSON result (read-only tools), skip
              }
            } else {
              emit({ type: "tool_error", toolName: event.toolName, error: event.result })
            }
            break
          case "done":
            emit({
              type: "final",
              result: {
                status: "applied",
                summary: event.summary,
                toolCallCount: event.toolCallCount,
              },
            })
            break
          case "error":
            emit({
              type: "error",
              result: { status: "error", summary: event.message },
            })
            break
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      emit({ type: "error", result: { status: "error", summary: msg } })
    }

    reply.raw.end()
    return reply
  })
}
