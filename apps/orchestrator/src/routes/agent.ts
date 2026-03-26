/**
 * Agent routes:
 *   POST /agent/start  — accepts request, returns streamId
 *   GET  /agent/stream  — SSE connection, runs agent loop, streams events
 *   POST /agent/chat    — blocking (non-SSE) for simple testing
 */

import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply } from "fastify"
import { scopedSessionKey } from "../state/session-state.js"
import { createAgentTools } from "../agent/agent-tools.js"
import { buildAgentSystemPrompt, buildContextMessage } from "../agent/agent-context.js"
import { runAgentLoop, type AgentEvent } from "../agent/agent-loop.js"
import { sseWrite } from "../chat/chat-pipeline-shared.js"

type AgentRequestBody = {
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

type AgentStreamEntry = {
  body: AgentRequestBody
  apiKey: string
  origin: string
  createdAt: number
  state: "pending" | "active" | "done" | "error"
  events: Array<{ seq: number; payload: Record<string, unknown> }>
  lastSeq: number
  subscribers: Set<FastifyReply>
}

/**
 * Parse "Suggested next actions:" bullet list from the agent's summary text.
 * Returns the summary without the suggestion block, plus the extracted suggestions.
 */
function parseSuggestionsFromSummary(text: string): { summary: string; suggestions: string[] } {
  const marker = /\n*(?:suggested\s+(?:next\s+)?actions|next\s+steps|you\s+(?:could|might)\s+(?:also|want\s+to)):\s*\n/i
  const match = text.match(marker)
  if (!match || match.index === undefined) return { summary: text.trim(), suggestions: [] }

  const before = text.slice(0, match.index).trim()
  const after = text.slice(match.index + match[0].length)
  const suggestions = after
    .split("\n")
    .map(line => line.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(line => line.length > 5 && line.length < 120)
    .slice(0, 4)

  return { summary: before, suggestions }
}

const streamContexts = new Map<string, AgentStreamEntry>()
const STREAM_TTL_MS = 120_000

function cleanExpired() {
  const now = Date.now()
  for (const [id, entry] of streamContexts) {
    if (now - entry.createdAt > STREAM_TTL_MS) streamContexts.delete(id)
  }
}

function emitEvent(streamId: string, payload: Record<string, unknown>) {
  const entry = streamContexts.get(streamId)
  if (!entry) return
  entry.lastSeq++
  const event = { seq: entry.lastSeq, payload: { ...payload, _seq: entry.lastSeq } }
  entry.events.push(event)
  for (const sub of entry.subscribers) {
    sseWrite(sub, event.payload)
  }
}

export async function registerAgentRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /agent/start — store request, return streamId
  // ---------------------------------------------------------------------------
  app.post("/agent/start", async (request, reply) => {
    cleanExpired()
    const apiKey = (request.headers["x-anthropic-api-key"] as string)?.trim()
    if (!apiKey) return reply.code(401).send({ error: "X-Anthropic-API-Key header required" })

    const body = request.body as AgentRequestBody
    if (!body.message?.trim()) return reply.code(400).send({ error: "message is required" })
    if (!body.siteId) return reply.code(400).send({ error: "siteId is required" })

    const streamId = randomUUID()
    streamContexts.set(streamId, {
      body,
      apiKey,
      origin: (request.headers.origin as string) ?? "*",
      createdAt: Date.now(),
      state: "pending",
      events: [],
      lastSeq: 0,
      subscribers: new Set(),
    })
    return reply.code(200).send({ streamId })
  })

  // ---------------------------------------------------------------------------
  // GET /agent/stream?streamId=X — SSE connection, runs agent loop
  // ---------------------------------------------------------------------------
  app.get("/agent/stream", async (request, reply) => {
    const { streamId, afterSeq } = request.query as { streamId?: string; afterSeq?: string }
    if (!streamId) return reply.code(400).send({ error: "streamId is required" })

    const entry = streamContexts.get(streamId)
    if (!entry) return reply.code(410).send({ error: "Stream not found or expired" })

    const reqOrigin = (request.headers.origin as string) ?? entry.origin
    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no")
    reply.raw.setHeader("Access-Control-Allow-Origin", reqOrigin)
    reply.raw.setHeader("Vary", "Origin")
    reply.raw.write("retry: 60000\n\n")

    // Replay buffered events
    const afterSeqNum = Number(afterSeq) || 0
    for (const event of entry.events) {
      if (event.seq > afterSeqNum) sseWrite(reply, event.payload)
    }

    // If already done, close
    if (entry.state === "done" || entry.state === "error") {
      reply.raw.end()
      return reply
    }

    // Subscribe for new events
    entry.subscribers.add(reply)
    request.raw.on("close", () => entry.subscribers.delete(reply))

    // If pending (first connection), start the agent loop
    if (entry.state === "pending") {
      entry.state = "active"

      const body = entry.body
      const session = scopedSessionKey(body.session ?? "dev", body.siteId ?? "")
      const tools = createAgentTools(session)
      const systemPrompt = buildAgentSystemPrompt({ locale: body.locale, sitePurpose: body.sitePurpose })
      const contextMsg = buildContextMessage(session, {
        slug: body.slug ?? "/",
        activeBlockId: body.activeBlockId,
        activeEditablePath: body.activeEditablePath,
      })
      const fullMessage = `${contextMsg}\n\n---\n\nUser request: ${body.message}`

      // Run agent loop in a detached async task (NOT awaited in this handler)
      const runLoop = async () => {
        try {
          for await (const event of runAgentLoop({
            apiKey: entry.apiKey,
            model: body.model,
            systemPrompt,
            tools,
            userMessage: fullMessage,
          })) {
            switch (event.type) {
              case "text_delta":
                emitEvent(streamId, { type: "summary_token", text: event.text })
                break
              case "tool_start":
                emitEvent(streamId, { type: "status", message: `Using ${event.toolName}...` })
                break
              case "tool_done":
                if (!event.isError) {
                  try {
                    const parsed = JSON.parse(event.result)
                    if (parsed.status === "applied") {
                      emitEvent(streamId, { type: "op_applied", toolName: event.toolName, previewVersion: parsed.previewVersion, focusBlockId: parsed.focusBlockId })
                    }
                  } catch { /* read-only tool */ }
                } else {
                  emitEvent(streamId, { type: "tool_error", toolName: event.toolName, error: event.result })
                }
                break
              case "done": {
                const { summary: cleanSummary, suggestions } = parseSuggestionsFromSummary(event.summary)
                emitEvent(streamId, { type: "final", result: { status: "applied", summary: cleanSummary, suggestions, toolCallCount: event.toolCallCount } })
                break
              }
              case "error":
                emitEvent(streamId, { type: "error", result: { status: "error", summary: event.message } })
                break
            }
          }
        } catch (err: unknown) {
          emitEvent(streamId, { type: "error", result: { status: "error", summary: err instanceof Error ? err.message : String(err) } })
        }
        entry.state = "done"
        // Close all subscriber connections
        for (const sub of entry.subscribers) {
          try { sub.raw.end() } catch { /* already closed */ }
        }
        entry.subscribers.clear()
      }

      // Fire and forget — the loop runs independently of this handler
      runLoop()
    }

    // Keep the connection open — don't return reply (Fastify will keep it alive)
    // The connection closes when the loop calls sub.raw.end() or client disconnects
  })

  // ---------------------------------------------------------------------------
  // POST /agent/chat — blocking (non-SSE) for testing
  // ---------------------------------------------------------------------------
  app.post("/agent/chat", async (request, reply) => {
    const apiKey = (request.headers["x-anthropic-api-key"] as string)?.trim()
    if (!apiKey) return reply.code(401).send({ error: "X-Anthropic-API-Key header required" })

    const body = request.body as AgentRequestBody
    if (!body.message?.trim()) return reply.code(400).send({ error: "message is required" })
    if (!body.siteId) return reply.code(400).send({ error: "siteId is required" })

    const session = scopedSessionKey(body.session ?? "dev", body.siteId)
    const tools = createAgentTools(session)
    const systemPrompt = buildAgentSystemPrompt({ locale: body.locale, sitePurpose: body.sitePurpose })
    const contextMsg = buildContextMessage(session, { slug: body.slug ?? "/", activeBlockId: body.activeBlockId, activeEditablePath: body.activeEditablePath })
    const fullMessage = `${contextMsg}\n\n---\n\nUser request: ${body.message}`

    const events: AgentEvent[] = []
    let summary = ""
    let toolCallCount = 0
    let error: string | null = null

    try {
      for await (const event of runAgentLoop({ apiKey, model: body.model, systemPrompt, tools, userMessage: fullMessage })) {
        events.push(event)
        if (event.type === "done") { summary = event.summary; toolCallCount = event.toolCallCount }
        if (event.type === "error") { error = event.message }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (error) return reply.code(500).send({ status: "error", error, events })
    return { status: "applied", summary, toolCallCount, events: events.map(e => {
      if (e.type === "tool_done") return { type: e.type, toolName: e.toolName, isError: e.isError }
      if (e.type === "tool_start") return { type: e.type, toolName: e.toolName }
      if (e.type === "text_delta") return { type: e.type, text: e.text }
      return e
    }) }
  })
}
