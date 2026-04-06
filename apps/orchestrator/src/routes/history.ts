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
  pushVersionEntry,
  getVersionLog,
  versions,
  schedulePersistState
} from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

export async function historyRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.get("/history/status", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string; slug?: string }
    if (!query.session || !query.slug) return reply.code(400).send({ error: "session and slug are required" })
    const session = scopedSessionKey(query.session, query.siteId)
    const undoList = getHistoryMap(historyUndo, session).get(query.slug) ?? []
    const redoList = getHistoryMap(historyRedo, session).get(query.slug) ?? []
    return { canUndo: undoList.length > 0, canRedo: redoList.length > 0 }
  })

  app.get("/history/log", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string; slug?: string; limit?: string }
    if (!query.session) return reply.code(400).send({ error: "session is required" })
    const session = scopedSessionKey(query.session, query.siteId)
    const limit = query.limit ? Math.min(parseInt(query.limit, 10) || 50, 100) : 50
    const entries = getVersionLog(session, query.slug, limit)
    const currentVersion = versions.get(session) ?? 0
    return { entries, currentVersion }
  })

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

    // null entry means "page didn't exist before" — undo removes it
    if (prev === null) {
      removePage(session, body.slug)
      const previewVersion = bumpVersion(session)
      pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Undo", opTypes: [], opCount: 0, source: "undo" })
      schedulePersistState(app.log)
      return { status: "applied", previewVersion, navigateToSlug: "/", canUndo: list.length > 0, canRedo: true }
    }

    setPage(session, structuredClone(prev))
    const previewVersion = bumpVersion(session)
    pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Undo", opTypes: [], opCount: 0, source: "undo" })
    schedulePersistState(app.log)

    // If the current page doesn't exist (was deleted), navigate to the restored page
    const currentPageExists = current !== null
    const navigateToSlug = !currentPageExists ? prev.slug : undefined
    return { status: "applied", previewVersion, canUndo: list.length > 0, canRedo: true, ...(navigateToSlug ? { navigateToSlug } : {}) }
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
      const previewVersion = bumpVersion(session)
      pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Redo", opTypes: [], opCount: 0, source: "redo" })
      schedulePersistState(app.log)
      return { status: "applied", previewVersion, navigateToSlug: "/", canUndo: true, canRedo: list.length > 0 }
    }

    setPage(session, structuredClone(next))
    const previewVersion = bumpVersion(session)
    pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Redo", opTypes: [], opCount: 0, source: "redo" })
    schedulePersistState(app.log)

    // If the current page doesn't exist (was deleted), navigate to the restored page
    const currentPageExists = current !== null
    const navigateToSlug = !currentPageExists ? next.slug : undefined
    return { status: "applied", previewVersion, canUndo: true, canRedo: list.length > 0, ...(navigateToSlug ? { navigateToSlug } : {}) }
  })
}
