import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { editorComponentsManifestSchema, operationSchema, type EditorComponentsManifest, type PageDoc } from "@ai-site-editor/shared"
import {
  scopedSessionKey,
  getPage,
  pushUndo,
  bumpVersion,
  pushRecentEdit,
  schedulePersistState
} from "../state/session-state.js"
import {
  applyOpsAtomically,
  pickFocusBlockId,
  pickUpdatedSlug,
  toErrorDetail,
  classifyGuardrailError
} from "../ops/ops-engine.js"
import { collectMentionedSlugsFromOps } from "../chat/chat-pipeline.js"
import type { RouteContext } from "./route-context.js"

type ApplyOpsRequestBody = {
  session?: string
  siteId?: string
  componentsManifest?: EditorComponentsManifest | string
  ops?: unknown
}

export async function opsRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.post("/ops", async (request, reply) => {
    const body = request.body as ApplyOpsRequestBody
    const session = scopedSessionKey(body.session, body.siteId)
    const parsedOps = z.array(operationSchema).safeParse(body.ops)
    if (!parsedOps.success) return reply.code(400).send({ error: "invalid ops payload" })
    if (parsedOps.data.length === 0) return reply.code(400).send({ error: "ops must not be empty" })
    const manifestPayload = (() => {
      if (!body.componentsManifest) return undefined
      if (typeof body.componentsManifest !== "string") return body.componentsManifest
      try {
        return JSON.parse(body.componentsManifest) as unknown
      } catch {
        return "__invalid_json__"
      }
    })()
    const parsedManifest =
      manifestPayload === "__invalid_json__"
        ? { success: false as const }
        : manifestPayload
          ? editorComponentsManifestSchema.safeParse(manifestPayload)
          : { success: true as const, data: undefined }
    if (!parsedManifest.success) return reply.code(400).send({ error: "invalid componentsManifest payload" })

    const snapshots = new Map<string, PageDoc>()
    for (const op of parsedOps.data) {
      if (!("pageSlug" in op) || typeof op.pageSlug !== "string") continue
      if (snapshots.has(op.pageSlug)) continue
      const current = getPage(session, op.pageSlug)
      if (!current) return reply.code(404).send({ error: `page not found: ${op.pageSlug}` })
      snapshots.set(op.pageSlug, current)
    }

    try {
      applyOpsAtomically(session, parsedOps.data, { componentsManifest: parsedManifest.data })
      for (const [slug, snapshot] of snapshots) pushUndo(session, slug, snapshot)
      const firstSlugOp = parsedOps.data.find((op) => "pageSlug" in op && typeof op.pageSlug === "string")
      const firstSlug = firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string" ? firstSlugOp.pageSlug : undefined
      const updatedSlug = firstSlug ? pickUpdatedSlug(session, firstSlug, parsedOps.data) : undefined
      if (firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string") {
        pushRecentEdit(session, { slug: updatedSlug ?? firstSlugOp.pageSlug, summary: "Applied operations.", ops: parsedOps.data })
      }
      const previewVersion = bumpVersion(session)
      schedulePersistState(app.log)
      const focusBlockId = pickFocusBlockId(parsedOps.data)
      return {
        status: "applied",
        summary: "Applied operations.",
        changes: [],
        mentionedSlugs: collectMentionedSlugsFromOps(parsedOps.data, updatedSlug ?? firstSlug),
        previewVersion,
        focusBlockId,
        updatedSlug
      }
    } catch (error) {
      const reason = toErrorDetail(error)
      return reply.code(400).send({ error: reason, errorCode: classifyGuardrailError(reason) })
    }
  })
}
