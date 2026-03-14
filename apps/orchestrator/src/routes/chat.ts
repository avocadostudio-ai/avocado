import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { ChatRequestBody } from "../nlp/intent-detection.js"
import {
  type ChatPipelineContext,
  CancelError,
  isCancelError,
  cleanupImagePlaceholders,
  sseWrite,
  runChatPipeline
} from "../chat/chat-pipeline.js"
import {
  type VariationRequestBody,
  runVariationPipeline
} from "../chat/variation-pipeline.js"
import { scopedSessionKey } from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

// ---------------------------------------------------------------------------
// Stream run constants
// ---------------------------------------------------------------------------

const STREAM_CONTEXT_TTL_MS = 60_000
const STREAM_RUN_TTL_MS = 900_000 // 15 min — keep terminal runs for replay
const STREAM_RUN_MAX_EVENTS = 2000
const MAX_PENDING_PER_SESSION = 3
const MAX_BODY_SIZE_BYTES = 512 * 1024 // 512 KB

// ---------------------------------------------------------------------------
// Stream context types
// ---------------------------------------------------------------------------

type StreamState = "pending" | "active" | "done" | "error" | "canceled"
type BufferedEvent = { seq: number; type: string; payload: unknown; at: string }
type Reply = { raw: NodeJS.WritableStream }

type StreamEntry = {
  body: ChatRequestBody
  session: string
  siteId: string
  origin: string
  createdAt: number
  state: StreamState
  abortController: AbortController
  events: BufferedEvent[]
  lastSeq: number
  subscribers: Set<Reply>
}

const streamContexts = new Map<string, StreamEntry>()

// ---------------------------------------------------------------------------
// Sweep timer — prune terminal runs past TTL
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000
let sweepTimer: ReturnType<typeof setInterval> | null = null

function startSweepTimer() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of streamContexts) {
      const isTerminal = entry.state === "done" || entry.state === "error" || entry.state === "canceled"
      if (isTerminal && now - entry.createdAt > STREAM_RUN_TTL_MS) {
        streamContexts.delete(id)
      }
      // Also clean up very old non-terminal entries (safety net)
      if (!isTerminal && now - entry.createdAt > STREAM_RUN_TTL_MS) {
        streamContexts.delete(id)
      }
    }
  }, SWEEP_INTERVAL_MS)
  // Don't prevent process exit
  if (sweepTimer && typeof sweepTimer === "object" && "unref" in sweepTimer) {
    sweepTimer.unref()
  }
}

function cleanExpiredStreamContexts() {
  const now = Date.now()
  for (const [id, entry] of streamContexts) {
    if (now - entry.createdAt > STREAM_CONTEXT_TTL_MS && entry.state === "pending") {
      streamContexts.delete(id)
    }
  }
}

function countPendingForSession(session: string, siteId?: string): number {
  let count = 0
  for (const entry of streamContexts.values()) {
    if (entry.session === session && entry.siteId === (siteId ?? "") && (entry.state === "pending" || entry.state === "active")) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Event buffering helper
// ---------------------------------------------------------------------------

function emitRunEvent(streamId: string, type: string, payload: unknown) {
  const entry = streamContexts.get(streamId)
  if (!entry) return

  entry.lastSeq += 1
  const event: BufferedEvent = {
    seq: entry.lastSeq,
    type,
    payload,
    at: new Date().toISOString()
  }

  // Bounded buffer — drop oldest if over max
  if (entry.events.length >= STREAM_RUN_MAX_EVENTS) {
    entry.events.shift()
  }
  entry.events.push(event)

  // Broadcast to all connected subscribers
  for (const subscriber of entry.subscribers) {
    sseWrite(subscriber, { ...payload as Record<string, unknown>, _seq: event.seq })
  }
}

function isTerminalState(state: StreamState): boolean {
  return state === "done" || state === "error" || state === "canceled"
}

// ---------------------------------------------------------------------------
// Find active stream for a session
// ---------------------------------------------------------------------------

function findActiveStreamForSession(session: string, siteId: string): [string, StreamEntry] | null {
  for (const [id, entry] of streamContexts) {
    if (entry.session === session && entry.siteId === siteId && entry.state === "active") {
      return [id, entry]
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function chatRoutes(app: FastifyInstance, ctx: RouteContext) {
  startSweepTimer()

  const pipelineCtx: ChatPipelineContext = {
    log: app.log,
    chatTelemetry: ctx.chatTelemetry,
    modelLookup: ctx.modelLookup,
    availableProviders: ctx.availableProviders,
    toolRuntime: ctx.toolRuntime
  }

  app.post("/chat", async (request, reply) => {
    const body = request.body as ChatRequestBody
    const result = await runChatPipeline(pipelineCtx, { ...body, session: scopedSessionKey(body.session, body.siteId) })
    return reply.code(result.code).send(result.payload)
  })

  app.post("/chat/variations", async (request, reply) => {
    const body = request.body as VariationRequestBody
    const result = await runVariationPipeline(pipelineCtx, { ...body, session: scopedSessionKey(body.session, body.siteId) })
    return reply.code(result.code).send(result.payload)
  })

  app.post("/chat/start", async (request, reply) => {
    cleanExpiredStreamContexts()

    const rawLength = request.headers["content-length"]
    if (rawLength && Number(rawLength) > MAX_BODY_SIZE_BYTES) {
      return reply.code(413).send({ error: "Request body too large" })
    }

    const body = request.body as ChatRequestBody
    if (!body.session) {
      return reply.code(400).send({ error: "session is required" })
    }

    if (countPendingForSession(body.session, body.siteId ?? "") >= MAX_PENDING_PER_SESSION) {
      return reply.code(429).send({ error: "Too many pending streams for this session" })
    }

    const streamId = randomUUID()
    const origin = request.headers.origin ?? "*"
    streamContexts.set(streamId, {
      body,
      session: body.session,
      siteId: body.siteId ?? "",
      origin,
      createdAt: Date.now(),
      state: "pending",
      abortController: new AbortController(),
      events: [],
      lastSeq: 0,
      subscribers: new Set()
    })
    return reply.code(200).send({ streamId })
  })

  // -------------------------------------------------------------------------
  // POST /chat/cancel
  // -------------------------------------------------------------------------

  app.post("/chat/cancel", async (request, reply) => {
    const body = request.body as { streamId?: string; session?: string; siteId?: string }
    const reqOrigin = request.headers.origin ?? "*"

    let streamId: string | undefined
    let entry: StreamEntry | undefined

    if (body.streamId) {
      streamId = body.streamId
      entry = streamContexts.get(streamId)
    } else if (body.session && body.siteId !== undefined) {
      const found = findActiveStreamForSession(body.session, body.siteId ?? "")
      if (found) {
        ;[streamId, entry] = found
      }
    }

    if (!entry || !streamId) {
      return reply
        .code(404)
        .header("Access-Control-Allow-Origin", reqOrigin)
        .send({ status: "not_found" })
    }

    if (isTerminalState(entry.state)) {
      return reply
        .code(200)
        .header("Access-Control-Allow-Origin", reqOrigin)
        .send({ status: "already_terminal" })
    }

    // Mark as canceled and abort
    entry.state = "canceled"
    entry.abortController.abort("user_canceled")
    emitRunEvent(streamId, "status", { type: "status", message: "Cancellation requested..." })

    return reply
      .code(200)
      .header("Access-Control-Allow-Origin", reqOrigin)
      .send({ status: "cancel_requested" })
  })

  // -------------------------------------------------------------------------
  // GET /chat/stream — with afterSeq replay support
  // -------------------------------------------------------------------------

  app.get("/chat/stream", async (request, reply) => {
    const rawQuery = request.query as Record<string, string>
    let query: ChatRequestBody
    let streamEntry: StreamEntry | undefined
    let streamId: string | undefined = rawQuery.streamId
    const afterSeq = Number(rawQuery.afterSeq ?? 0) || 0
    const isReconnect = afterSeq > 0
    const reqOrigin = request.headers.origin ?? "*"

    if (streamId) {
      streamEntry = streamContexts.get(streamId)
      if (!streamEntry) {
        return reply
          .code(410)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Stream context expired or not found" })
      }

      // For pending streams that expired, clean up
      if (streamEntry.state === "pending" && Date.now() - streamEntry.createdAt > STREAM_CONTEXT_TTL_MS) {
        streamContexts.delete(streamId)
        return reply
          .code(410)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Stream context expired or not found" })
      }

      // Origin check
      if (streamEntry.origin !== "*" && reqOrigin !== "*" && streamEntry.origin !== reqOrigin) {
        return reply
          .code(403)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Origin mismatch" })
      }

      // Handle reconnection to active/terminal runs
      if (isReconnect) {
        // Set up SSE headers
        const origin = streamEntry.origin !== "*" ? streamEntry.origin : reqOrigin
        reply.raw.setHeader("Content-Type", "text/event-stream")
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
        reply.raw.setHeader("Connection", "keep-alive")
        reply.raw.setHeader("X-Accel-Buffering", "no")
        reply.raw.setHeader("Access-Control-Allow-Origin", origin)
        reply.raw.setHeader("Vary", "Origin")
        reply.raw.write("retry: 60000\n\n")

        // Replay buffered events where seq > afterSeq
        for (const event of streamEntry.events) {
          if (event.seq > afterSeq) {
            sseWrite(reply, { ...event.payload as Record<string, unknown>, _seq: event.seq })
          }
        }

        if (isTerminalState(streamEntry.state)) {
          // Run is done — close connection after replay
          reply.raw.end()
          return reply
        }

        // Still active — subscribe for future events
        streamEntry.subscribers.add(reply)
        request.raw.on("close", () => {
          streamEntry!.subscribers.delete(reply)
        })

        // Keep connection open — Fastify won't auto-end because we set headers manually
        return reply
      }

      // Non-reconnect: original connection flow
      if (streamEntry.state === "done" || streamEntry.state === "error" || streamEntry.state === "canceled") {
        return reply
          .code(410)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Stream already completed" })
      }

      if (streamEntry.state === "active") {
        return reply
          .code(409)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Pipeline already running" })
      }

      streamEntry.state = "active"
      query = streamEntry.body
    } else {
      query = rawQuery as unknown as ChatRequestBody
    }

    const scopedQuery: ChatRequestBody = { ...query, session: scopedSessionKey(query.session, query.siteId) }
    const origin = streamEntry?.origin !== "*" ? (streamEntry?.origin ?? reqOrigin) : reqOrigin

    reply.raw.setHeader("Content-Type", "text/event-stream")
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
    reply.raw.setHeader("Connection", "keep-alive")
    reply.raw.setHeader("X-Accel-Buffering", "no")
    reply.raw.setHeader("Access-Control-Allow-Origin", origin)
    reply.raw.setHeader("Vary", "Origin")

    reply.raw.write("retry: 60000\n\n")

    // Add this connection as a subscriber
    if (streamEntry && streamId) {
      streamEntry.subscribers.add(reply)
      request.raw.on("close", () => {
        streamEntry!.subscribers.delete(reply)
      })
    }

    // Helper that emits via event buffer (if streamId) or direct write (legacy)
    const emit = (type: string, payload: Record<string, unknown>) => {
      if (streamId && streamEntry) {
        emitRunEvent(streamId, type, payload)
      } else {
        sseWrite(reply, payload)
      }
    }

    const streamStartedAt = Date.now()
    let heartbeatStage: "planning" | "applying" = "planning"
    let heartbeatLabel = "Planning"
    const heartbeatTimer = setInterval(() => {
      emit("heartbeat", {
        type: "heartbeat",
        stage: heartbeatStage,
        label: heartbeatLabel,
        elapsedMs: Date.now() - streamStartedAt
      })
    }, 1000)

    const abortSignal = streamEntry?.abortController.signal

    try {
      const result = await runChatPipeline(pipelineCtx, scopedQuery, {
        signal: abortSignal,
        onPlanningToken: (token) => emit("token", { type: "token", text: token }),
        onSummaryChunk: (text) => emit("summary_token", { type: "summary_token", text }),
        onChangeLogEntry: (entry) => emit("changelog_entry", { type: "changelog_entry", entry }),
        onPlannedOp: (event) =>
          emit("op_candidate", {
            type: "op_candidate",
            index: event.index,
            op: event.op
          }),
        onOpSkipped: (event) =>
          emit("op_skipped", {
            type: "op_skipped",
            index: event.index,
            total: event.total,
            op: event.op,
            reason: event.reason
          }),
        onPlanMeta: (event) => {
          const n = event.estimatedOps ?? 0
          heartbeatLabel = n > 0 ? `Plan ready (${n} change${n === 1 ? "" : "s"})` : "Plan ready"
          emit("plan_meta", {
            type: "plan_meta",
            intent: event.intent,
            summary: event.summary,
            estimatedOps: event.estimatedOps
          })
        },
        onOpApplied: (event) => {
          heartbeatStage = "applying"
          heartbeatLabel = event.total > 0
            ? `Applying changes (${event.index}/${event.total})`
            : "Applying changes"
          emit("op_applied", {
            type: "op_applied",
            index: event.index,
            total: event.total,
            op: event.op,
            previewVersion: event.previewVersion,
            focusBlockId: event.focusBlockId ?? null,
            ...(event.updatedSlug ? { updatedSlug: event.updatedSlug } : {})
          })
        },
        onRollbackStarted: (event) =>
          emit("rollback_started", {
            type: "rollback_started",
            appliedCount: event.appliedCount,
            reason: event.reason
          }),
        onRollbackDone: (event) =>
          emit("rollback_done", {
            type: "rollback_done",
            restoredVersion: event.restoredVersion
          }),
        onStatusUpdate: (message) => {
          heartbeatLabel = message
          emit("status", { type: "status", message })
        },
        onImageProgress: (event) => emit("image_progress", { type: "image_progress", ...event })
      })

      if (result.code >= 400) {
        emit("error", { type: "error", result: result.payload, code: result.code })
        if (streamEntry) streamEntry.state = "error"
      } else {
        emit("final", { type: "final", result: result.payload })
        if (streamEntry) streamEntry.state = "done"
      }
    } catch (err) {
      if (isCancelError(err)) {
        cleanupImagePlaceholders(scopedQuery.session ?? "dev")
        emit("canceled", { type: "canceled", message: "Run was canceled." })
        if (streamEntry) streamEntry.state = "canceled"
      } else {
        const message = err instanceof Error ? err.message : String(err)
        emit("error", { type: "error", result: { error: message }, code: 500 })
        if (streamEntry) streamEntry.state = "error"
      }
    } finally {
      clearInterval(heartbeatTimer)

      // Close all subscriber connections for terminal runs
      if (streamEntry) {
        for (const sub of streamEntry.subscribers) {
          try {
            const stream = sub.raw as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }
            if (!stream.destroyed && !stream.writableEnded) {
              stream.end()
            }
          } catch { /* ignore */ }
        }
        streamEntry.subscribers.clear()
      } else {
        // Legacy (no streamId) — end the reply directly
        try { reply.raw.end() } catch { /* ignore */ }
      }
    }

    return reply
  })
}
