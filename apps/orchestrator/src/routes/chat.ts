import { randomUUID } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { ChatRequestBody } from "../nlp/intent-detection.js"
import {
  type ChatPipelineContext,
  sseWrite,
  runChatPipeline
} from "../chat/chat-pipeline.js"
import {
  type VariationRequestBody,
  runVariationPipeline
} from "../chat/variation-pipeline.js"
import { scopedSessionKey } from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

const STREAM_CONTEXT_TTL_MS = 60_000
const MAX_PENDING_PER_SESSION = 3
const MAX_BODY_SIZE_BYTES = 512 * 1024 // 512 KB

type StreamState = "pending" | "active" | "done"
type StreamEntry = {
  body: ChatRequestBody
  session: string
  siteId: string
  origin: string
  createdAt: number
  state: StreamState
}
const streamContexts = new Map<string, StreamEntry>()

function cleanExpiredStreamContexts() {
  const now = Date.now()
  for (const [id, entry] of streamContexts) {
    if (now - entry.createdAt > STREAM_CONTEXT_TTL_MS) streamContexts.delete(id)
  }
}

function countPendingForSession(session: string, siteId?: string): number {
  let count = 0
  for (const entry of streamContexts.values()) {
    if (entry.session === session && entry.siteId === (siteId ?? "") && entry.state !== "done") count++
  }
  return count
}

export async function chatRoutes(app: FastifyInstance, ctx: RouteContext) {
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
      state: "pending"
    })
    return reply.code(200).send({ streamId })
  })

  app.get("/chat/stream", async (request, reply) => {
    const rawQuery = request.query as Record<string, string>
    let query: ChatRequestBody
    let streamEntry: StreamEntry | undefined
    const reqOrigin = request.headers.origin ?? "*"

    if (rawQuery.streamId) {
      streamEntry = streamContexts.get(rawQuery.streamId)
      if (!streamEntry || Date.now() - streamEntry.createdAt > STREAM_CONTEXT_TTL_MS) {
        streamContexts.delete(rawQuery.streamId)
        return reply
          .code(410)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Stream context expired or not found" })
      }
      if (streamEntry.state === "done") {
        streamContexts.delete(rawQuery.streamId)
        return reply
          .code(410)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Stream already completed" })
      }
      if (streamEntry.origin !== "*" && reqOrigin !== "*" && streamEntry.origin !== reqOrigin) {
        return reply
          .code(403)
          .header("Access-Control-Allow-Origin", reqOrigin)
          .send({ error: "Origin mismatch" })
      }
      if (streamEntry.state === "active") {
        // Pipeline is already running on the original socket; we cannot
        // replay events to a new connection. Return plain HTTP 409 (not SSE)
        // so EventSource triggers onerror — not onmessage — and the client
        // falls back to POST /chat without polluting gotAnyEvent.
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
    sseWrite(reply, { type: "status", message: "Crafting your update..." })
    const streamStartedAt = Date.now()
    let heartbeatStage: "planning" | "applying" = "planning"
    const heartbeatTimer = setInterval(() => {
      sseWrite(reply, {
        type: "heartbeat",
        stage: heartbeatStage,
        elapsedMs: Date.now() - streamStartedAt
      })
    }, 1000)
    try {
      const result = await runChatPipeline(pipelineCtx, scopedQuery, {
        onPlanningToken: (token) => sseWrite(reply, { type: "token", text: token }),
        onSummaryChunk: (text) => sseWrite(reply, { type: "summary_token", text }),
        onChangeLogEntry: (entry) => sseWrite(reply, { type: "changelog_entry", entry }),
        onPlannedOp: (event) =>
          sseWrite(reply, {
            type: "op_candidate",
            index: event.index,
            op: event.op
          }),
        onOpSkipped: (event) =>
          sseWrite(reply, {
            type: "op_skipped",
            index: event.index,
            total: event.total,
            op: event.op,
            reason: event.reason
          }),
        onPlanMeta: (event) => {
          sseWrite(reply, {
            type: "plan_meta",
            intent: event.intent,
            summary: event.summary,
            estimatedOps: event.estimatedOps
          })
        },
        onOpApplied: (event) => {
          heartbeatStage = "applying"
          sseWrite(reply, {
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
          sseWrite(reply, {
            type: "rollback_started",
            appliedCount: event.appliedCount,
            reason: event.reason
          }),
        onRollbackDone: (event) =>
          sseWrite(reply, {
            type: "rollback_done",
            restoredVersion: event.restoredVersion
          }),
        onStatusUpdate: (message) => sseWrite(reply, { type: "status", message }),
        onImageProgress: (event) => sseWrite(reply, { type: "image_progress", ...event })
      })
      if (result.code >= 400) {
        sseWrite(reply, { type: "error", result: result.payload, code: result.code })
        reply.raw.end()
        return reply
      }

      sseWrite(reply, { type: "final", result: result.payload })
      reply.raw.end()
      return reply
    } finally {
      clearInterval(heartbeatTimer)
      if (streamEntry) {
        streamEntry.state = "done"
        // Clean up after a short delay to handle any final reconnects
        setTimeout(() => streamContexts.delete(rawQuery.streamId), 5_000)
      }
    }
  })
}
