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

export async function chatRoutes(app: FastifyInstance, ctx: RouteContext) {
  const pipelineCtx: ChatPipelineContext = { log: app.log, chatTelemetry: ctx.chatTelemetry, modelLookup: ctx.modelLookup, availableProviders: ctx.availableProviders }

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

  app.get("/chat/stream", async (request, reply) => {
    const query = request.query as ChatRequestBody
    const scopedQuery: ChatRequestBody = { ...query, session: scopedSessionKey(query.session, query.siteId) }
    const origin = request.headers.origin ?? "*"

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
            focusBlockId: event.focusBlockId ?? null
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
        onStatusUpdate: (message) => sseWrite(reply, { type: "status", message })
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
    }
  })
}
