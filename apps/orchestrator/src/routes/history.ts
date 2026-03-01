import type { FastifyInstance } from "fastify"
import {
  scopedSessionKey,
  historyUndo,
  historyRedo,
  getHistoryMap,
  getPage,
  setPage,
  bumpVersion,
  schedulePersistState
} from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

export async function historyRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.post("/history/undo", async (request, reply) => {
    const body = request.body as { session?: string; siteId?: string; slug?: string }
    if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })
    const session = scopedSessionKey(body.session, body.siteId)

    const undoMap = getHistoryMap(historyUndo, session)
    const redoMap = getHistoryMap(historyRedo, session)
    const list = undoMap.get(body.slug) ?? []
    if (list.length === 0) return reply.code(400).send({ error: "nothing to undo" })

    const current = getPage(session, body.slug)
    if (!current) return reply.code(404).send({ error: "page not found" })

    const prev = list.pop()
    undoMap.set(body.slug, list)
    if (!prev) return reply.code(400).send({ error: "nothing to undo" })

    const redoList = redoMap.get(body.slug) ?? []
    redoList.push(structuredClone(current))
    redoMap.set(body.slug, redoList)

    setPage(session, structuredClone(prev))
    const previewVersion = bumpVersion(session)
    schedulePersistState(app.log)
    return { status: "applied", previewVersion }
  })

  app.post("/history/redo", async (request, reply) => {
    const body = request.body as { session?: string; siteId?: string; slug?: string }
    if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })
    const session = scopedSessionKey(body.session, body.siteId)

    const undoMap = getHistoryMap(historyUndo, session)
    const redoMap = getHistoryMap(historyRedo, session)
    const list = redoMap.get(body.slug) ?? []
    if (list.length === 0) return reply.code(400).send({ error: "nothing to redo" })

    const current = getPage(session, body.slug)
    if (!current) return reply.code(404).send({ error: "page not found" })

    const next = list.pop()
    redoMap.set(body.slug, list)
    if (!next) return reply.code(400).send({ error: "nothing to redo" })

    const undoList = undoMap.get(body.slug) ?? []
    undoList.push(structuredClone(current))
    undoMap.set(body.slug, undoList)

    setPage(session, structuredClone(next))
    const previewVersion = bumpVersion(session)
    schedulePersistState(app.log)
    return { status: "applied", previewVersion }
  })
}
