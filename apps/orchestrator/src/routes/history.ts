import type { FastifyInstance } from "fastify"
import {
  scopedSessionKey,
  historyUndo,
  historyRedo,
  getHistoryMap,
  getPage,
  setPage,
  removePage,
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
    // current may be null if the page was deleted — that's OK, we'll restore from snapshot

    const prev = list.pop()
    undoMap.set(body.slug, list)
    if (prev === undefined) return reply.code(400).send({ error: "nothing to undo" })

    const redoList = redoMap.get(body.slug) ?? []
    // Push current state to redo: null means "page was deleted" (redo will re-delete)
    redoList.push(current ? structuredClone(current) : null as any)
    redoMap.set(body.slug, redoList)

    // null entry means "page was deleted by redo" — undo re-creates it
    if (prev === null) {
      removePage(session, body.slug)
    } else {
      setPage(session, structuredClone(prev))
    }
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
    // current may be null if the page was previously deleted and redo re-deletes it

    const next = list.pop()
    redoMap.set(body.slug, list)
    if (next === undefined) return reply.code(400).send({ error: "nothing to redo" })

    const undoList = undoMap.get(body.slug) ?? []
    undoList.push(current ? structuredClone(current) : null as any)
    undoMap.set(body.slug, undoList)

    // null entry means "page was deleted" — redo re-deletes it
    if (next === null) {
      removePage(session, body.slug)
    } else {
      setPage(session, structuredClone(next))
    }
    const previewVersion = bumpVersion(session)
    schedulePersistState(app.log)
    return { status: "applied", previewVersion }
  })
}
