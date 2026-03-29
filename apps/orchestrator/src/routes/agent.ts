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
import { runAgentLoop, type AgentEvent, type AgentTokenUsage } from "../agent/agent-loop.js"
import { type AgentProvider, detectProviderFromKey, resolveAgentModel } from "../agent/agent-provider.js"
import { sseWrite, parseSuggestionsFromSummary } from "../chat/chat-pipeline-shared.js"

/** Extract API key from request headers (new generic header, with backward compat). */
function extractAgentApiKey(headers: Record<string, unknown>): string | undefined {
  return ((headers["x-agent-api-key"] as string) ?? (headers["x-anthropic-api-key"] as string))?.trim() || undefined
}

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
  provider: AgentProvider
  origin: string
  createdAt: number
  state: "pending" | "active" | "done" | "error"
  events: Array<{ seq: number; payload: Record<string, unknown> }>
  lastSeq: number
  subscribers: Set<FastifyReply>
  abortController: AbortController
}

/** Human-readable labels for agent tool names shown in the streaming UI. */
const TOOL_LABELS: Record<string, string> = {
  get_page: "Reading page content",
  list_pages: "Checking available pages",
  get_block_schema: "Looking up block structure",
  get_site_config: "Reading site settings",
  batch_update_props: "Updating content",
  edit_page: "Editing page",
  add_block_with_content: "Adding new section",
  remove_block: "Removing section",
  move_block: "Rearranging sections",
  create_page: "Creating new page",
  rename_page: "Renaming page",
  remove_page: "Removing page",
  move_page: "Moving page",
  duplicate_block: "Duplicating section",
  duplicate_page: "Duplicating page",
  unsplash_search: "Searching for photos",
  image_generate: "Generating image",
  update_site_config: "Updating site settings",
  generate_variations: "Creating alternatives",
  add_item: "Adding list item",
  update_item: "Updating list item",
  remove_item: "Removing list item",
  move_item: "Reordering list",
}

const streamContexts = new Map<string, AgentStreamEntry>()
const STREAM_TTL_MS = 120_000
const STREAM_HEARTBEAT_INTERVAL_MS = 4_000

function cleanExpired() {
  const now = Date.now()
  for (const [id, entry] of streamContexts) {
    if (entry.state === "active") continue // never drop active streams
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
    const apiKey = extractAgentApiKey(request.headers as Record<string, unknown>)
    if (!apiKey) return reply.code(401).send({ error: "x-agent-api-key header required" })

    const provider = detectProviderFromKey(apiKey)
    if (!provider) return reply.code(401).send({ error: "Unrecognized API key format. Provide an Anthropic (sk-ant-...) or OpenAI (sk-...) key." })

    const body = request.body as AgentRequestBody
    if (!body.message?.trim()) return reply.code(400).send({ error: "message is required" })
    if (!body.siteId) return reply.code(400).send({ error: "siteId is required" })

    const streamId = randomUUID()
    streamContexts.set(streamId, {
      body,
      apiKey,
      provider,
      origin: (request.headers.origin as string) ?? "*",
      createdAt: Date.now(),
      state: "pending",
      events: [],
      lastSeq: 0,
      subscribers: new Set(),
      abortController: new AbortController(),
    })
    return reply.code(200).send({ streamId })
  })

  // ---------------------------------------------------------------------------
  // POST /agent/cancel — abort a running agent loop
  // ---------------------------------------------------------------------------
  app.post("/agent/cancel", async (request, reply) => {
    const { streamId } = request.body as { streamId?: string }
    if (!streamId) return reply.code(400).send({ error: "streamId is required" })

    const entry = streamContexts.get(streamId)
    if (!entry) return reply.code(410).send({ error: "Stream not found or expired" })

    if (entry.state === "active" || entry.state === "pending") {
      entry.abortController.abort()
      entry.state = "done"
      emitEvent(streamId, { type: "error", result: { status: "error", summary: "Canceled by user" } })
      for (const sub of entry.subscribers) {
        try { sub.raw.end() } catch { /* already closed */ }
      }
      entry.subscribers.clear()
    }

    return { ok: true }
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
        let pendingVariations: Record<string, unknown> | undefined
        const startedAt = Date.now()
        let heartbeatStage: "thinking" | "tool" | "responding" | "applying" = "thinking"
        const heartbeatTimer = setInterval(() => {
          if (entry.state !== "active") return
          emitEvent(streamId, {
            type: "heartbeat",
            stage: heartbeatStage,
            elapsedMs: Date.now() - startedAt
          })
        }, STREAM_HEARTBEAT_INTERVAL_MS)
        try {
          for await (const event of runAgentLoop({
            apiKey: entry.apiKey,
            provider: entry.provider,
            model: resolveAgentModel(entry.provider, body.model),
            systemPrompt,
            tools,
            userMessage: fullMessage,
            signal: entry.abortController.signal,
          })) {
            switch (event.type) {
              case "text_delta":
                heartbeatStage = "responding"
                emitEvent(streamId, { type: "summary_token", text: event.text })
                break
              case "tool_start":
                heartbeatStage = "tool"
                emitEvent(streamId, { type: "status", message: `${TOOL_LABELS[event.toolName] ?? event.toolName}...` })
                break
              case "tool_done":
                heartbeatStage = "thinking"
                if (!event.isError) {
                  try {
                    const parsed = JSON.parse(event.result)
                    if (parsed.status === "applied") {
                      heartbeatStage = "applying"
                      emitEvent(streamId, { type: "op_applied", toolName: event.toolName, previewVersion: parsed.previewVersion, focusBlockId: parsed.focusBlockId })
                      const desc = parsed.changeDescription ?? parsed.summary
                      if (typeof desc === "string" && desc.length > 0) {
                        emitEvent(streamId, { type: "changelog_entry", entry: desc })
                      }
                    } else if (parsed.status === "ok" && Array.isArray(parsed.variations)) {
                      // Variation result — store for inclusion in final event
                      pendingVariations = parsed
                      emitEvent(streamId, { type: "status", message: `Generated ${parsed.variations.length} variations` })
                    }
                  } catch { /* read-only tool */ }
                } else {
                  emitEvent(streamId, { type: "tool_error", toolName: event.toolName, error: event.result })
                }
                heartbeatStage = "thinking"
                break
              case "done": {
                const { summary: cleanSummary, suggestions } = parseSuggestionsFromSummary(event.summary)
                emitEvent(streamId, { type: "final", result: { status: "applied", summary: cleanSummary, suggestions, variations: pendingVariations, toolCallCount: event.toolCallCount } })
                break
              }
              case "error":
                emitEvent(streamId, { type: "error", result: { status: "error", summary: event.message } })
                break
            }
          }
        } catch (err: unknown) {
          emitEvent(streamId, { type: "error", result: { status: "error", summary: err instanceof Error ? err.message : String(err) } })
        } finally {
          clearInterval(heartbeatTimer)
          entry.state = "done"
          // Close all subscriber connections
          for (const sub of entry.subscribers) {
            try { sub.raw.end() } catch { /* already closed */ }
          }
          entry.subscribers.clear()
        }
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
    const apiKey = extractAgentApiKey(request.headers as Record<string, unknown>)
    if (!apiKey) return reply.code(401).send({ error: "x-agent-api-key header required" })

    const provider = detectProviderFromKey(apiKey)
    if (!provider) return reply.code(401).send({ error: "Unrecognized API key format. Provide an Anthropic (sk-ant-...) or OpenAI (sk-...) key." })

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
    let usage: AgentTokenUsage | undefined
    let error: string | null = null

    try {
      for await (const event of runAgentLoop({ apiKey, provider, model: resolveAgentModel(provider, body.model), systemPrompt, tools, userMessage: fullMessage })) {
        events.push(event)
        if (event.type === "done") { summary = event.summary; toolCallCount = event.toolCallCount; usage = event.usage }
        if (event.type === "error") { error = event.message }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err)
    }

    if (error) return reply.code(500).send({ status: "error", error, events })
    return { status: "applied", summary, toolCallCount, usage, events: events.map(e => {
      if (e.type === "tool_done") return { type: e.type, toolName: e.toolName, isError: e.isError }
      if (e.type === "tool_start") return { type: e.type, toolName: e.toolName }
      if (e.type === "text_delta") return { type: e.type, text: e.text }
      return e
    }) }
  })
}
