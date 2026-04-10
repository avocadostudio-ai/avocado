import type { FastifyInstance } from "fastify"
import {
  scopedSessionKey,
  historyUndo,
  historyRedo,
  getHistoryMap,
  getPage,
  setPage,
  removePage,
  pushUndo,
  bumpVersion,
  pushVersionEntry,
  getVersionLog,
  versions,
  versionLog,
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
    // Strip snapshots from the response to keep payloads small.
    const entries = getVersionLog(session, query.slug, limit).map(({ snapshot: _snapshot, ...rest }) => rest)
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
      pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Undo", opTypes: [], opCount: 0, source: "undo", snapshot: null })
      schedulePersistState(app.log)
      return { status: "applied", previewVersion, navigateToSlug: "/", canUndo: list.length > 0, canRedo: true }
    }

    setPage(session, structuredClone(prev))
    const previewVersion = bumpVersion(session)
    pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Undo", opTypes: [], opCount: 0, source: "undo", snapshot: structuredClone(prev) })
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
      pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Redo", opTypes: [], opCount: 0, source: "redo", snapshot: null })
      schedulePersistState(app.log)
      return { status: "applied", previewVersion, navigateToSlug: "/", canUndo: true, canRedo: list.length > 0 }
    }

    setPage(session, structuredClone(next))
    const previewVersion = bumpVersion(session)
    pushVersionEntry(session, { version: previewVersion, slug: body.slug, summary: "Redo", opTypes: [], opCount: 0, source: "redo", snapshot: structuredClone(next) })
    schedulePersistState(app.log)

    // If the current page doesn't exist (was deleted), navigate to the restored page
    const currentPageExists = current !== null
    const navigateToSlug = !currentPageExists ? next.slug : undefined
    return { status: "applied", previewVersion, canUndo: true, canRedo: list.length > 0, ...(navigateToSlug ? { navigateToSlug } : {}) }
  })

  /**
   * Restore the live state to any prior version by directly applying the
   * snapshot stored on the target VersionEntry. Independent of undo/redo
   * stacks — this enables true back-and-forth navigation: every entry in
   * the log remains restorable even after jumping to another entry.
   *
   * The restore is itself an edit: the current state is pushed onto the
   * undo stack (so Ctrl+Z undoes the restore), and a new `restore` entry
   * is appended to the version log with its own snapshot.
   */
  app.post("/history/restore", async (request, reply) => {
    const body = request.body as { session?: string; siteId?: string; targetVersion?: number }
    if (!body.session || typeof body.targetVersion !== "number") {
      return reply.code(400).send({ error: "session and targetVersion are required" })
    }
    const session = scopedSessionKey(body.session, body.siteId)

    const log = versionLog.get(session) ?? []
    const target = log.find((e) => e.version === body.targetVersion)
    if (!target) {
      return reply.code(404).send({ error: "target version not found" })
    }
    if (target.snapshot === undefined) {
      return reply.code(400).send({ error: "target version has no restorable snapshot (legacy entry)" })
    }

    // Save current state to the target slug's undo stack so Ctrl+Z undoes the
    // restore. pushUndo also clears the redo stack — that's fine, since a
    // restore is effectively a new branch.
    const current = getPage(session, target.slug)
    pushUndo(session, target.slug, current)

    // Directly apply the target snapshot.
    if (target.snapshot === null) {
      removePage(session, target.slug)
    } else {
      setPage(session, structuredClone(target.snapshot))
    }

    const previewVersion = bumpVersion(session)
    pushVersionEntry(session, {
      version: previewVersion,
      slug: target.slug,
      summary: `Restored to v${body.targetVersion}`,
      opTypes: [],
      opCount: 0,
      source: "restore",
      snapshot: target.snapshot === null ? null : structuredClone(target.snapshot)
    })
    schedulePersistState(app.log)

    const undoList = getHistoryMap(historyUndo, session).get(target.slug) ?? []
    const redoList = getHistoryMap(historyRedo, session).get(target.slug) ?? []
    return {
      status: "applied",
      previewVersion,
      navigateToSlug: target.slug,
      canUndo: undoList.length > 0,
      canRedo: redoList.length > 0
    }
  })
}
