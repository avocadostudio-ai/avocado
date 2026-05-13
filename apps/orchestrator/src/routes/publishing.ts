import type { FastifyInstance, FastifyBaseLogger } from "fastify"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { PageDoc } from "@avocadostudio-ai/shared"
import {
  normalizeSession,
  scopedSessionKey,
  publishStatusBySession,
  getSessionPages,
  getSiteConfig,
  getSessionDraft,
  ensureHeroImageProps,
  bumpVersion,
  schedulePersistState,
  setLastPublishedScopedSession,
  markRecentlyRestored,
  publishedPages
} from "../state/session-state.js"
import { computePublishDiff } from "../publish/diff-engine.js"
import { toErrorDetail } from "../ops/ops-engine.js"
import {
  refreshPublishStatusFromVercel,
  requirePublishToken,
  listRestoreSnapshots,
  deletePublishSnapshot,
  loadPublishedSnapshotFromCommit
} from "../publish/publish-helpers.js"
import { selectPublishTarget } from "../publish/publish-target-registry.js"
import type { PublishContext } from "../publish/publish-target.js"
import type { RouteContext } from "./route-context.js"

/**
 * Load the authoritative published pages for diff computation.
 *
 * Priority (first hit wins):
 *   1. `${siteOrigin}/api/editor/pages` — accurate in both dev and prod.
 *   2. `PUBLISHED_CONTENT_PATH` env var — direct file read (ops override).
 *   3. `apps/site/lib/published-content.json` — monorepo default for local dev.
 *   4. In-memory `publishedPages` Map — stale demo seed, last resort.
 *
 * The in-memory Map is NOT authoritative: it is seeded from demo data at
 * startup and never updated on publish. Relying on it produces bogus diffs
 * (e.g. "all pages added" when the site already has them published).
 */
async function loadPublishedForDiff(opts: {
  siteOrigin?: string
  logger: FastifyBaseLogger
}): Promise<PageDoc[]> {
  const { siteOrigin, logger } = opts

  if (siteOrigin) {
    try {
      const res = await fetch(`${siteOrigin.replace(/\/+$/, "")}/api/editor/pages`, {
        headers: { accept: "application/json" },
      })
      if (res.ok) {
        const data = (await res.json()) as { pages?: PageDoc[] }
        if (Array.isArray(data.pages)) return data.pages
      } else {
        logger.warn({ siteOrigin, status: res.status }, "publish/diff: site pages endpoint not ok, falling back")
      }
    } catch (err) {
      logger.warn({ siteOrigin, err: String(err) }, "publish/diff: site fetch failed, falling back")
    }
  }

  const paths: string[] = []
  if (process.env.PUBLISHED_CONTENT_PATH?.trim()) paths.push(process.env.PUBLISHED_CONTENT_PATH.trim())
  // Monorepo default — orchestrator cwd is apps/orchestrator in dev.
  paths.push(resolve(process.cwd(), "../../apps/site/lib/published-content.json"))
  paths.push(resolve(process.cwd(), "../site/lib/published-content.json"))

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8")
      const parsed = JSON.parse(raw) as { pages?: PageDoc[] } | PageDoc[]
      const pages = Array.isArray(parsed) ? parsed : parsed.pages
      if (Array.isArray(pages)) return pages
    } catch {
      // Try the next candidate.
    }
  }

  logger.warn("publish/diff: falling back to in-memory publishedPages — diff may be inaccurate")
  return Array.from(publishedPages.values())
}

/** Reject origins that point at private/loopback IPs or non-http protocols. */
function isSafeOrigin(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const host = parsed.hostname
  const isPrivate =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (isPrivate) {
    if (process.env.NODE_ENV !== "production") return true
    // In production, allow if the origin is in ORCHESTRATOR_CORS_ORIGINS
    const corsOrigins = (process.env.ORCHESTRATOR_CORS_ORIGINS ?? "").split(",").map(s => s.trim().replace(/\/+$/, ""))
    const normalized = parsed.origin
    if (corsOrigins.some(o => o === normalized)) return true
    return false
  }
  return true
}

export async function publishingRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/publish/diff", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string; siteOrigin?: string }
    if (!query.session) return reply.code(400).send({ error: "session is required" })
    const scopedSession = scopedSessionKey(normalizeSession(query.session), query.siteId)
    const draft = getSessionPages(scopedSession)
    const published = await loadPublishedForDiff({
      siteOrigin: query.siteOrigin,
      logger: app.log,
    })
    return computePublishDiff(draft, published)
  })

  app.post("/publish", async (request, reply) => {
    if (!requirePublishToken(request as { headers: Record<string, unknown> })) {
      return reply.code(401).send({ error: "invalid publish token" })
    }

    const body = (request.body ?? {}) as { session?: string; siteId?: string; siteOrigin?: string }
    const session = normalizeSession(body.session)
    const scopedSession = scopedSessionKey(session, body.siteId)
    const siteOrigin = typeof body.siteOrigin === "string" ? body.siteOrigin.trim().replace(/\/+$/, "") : ""

    if (siteOrigin && !isSafeOrigin(siteOrigin)) {
      request.log.warn({ siteOrigin, session, siteId: body.siteId }, "publish: rejected siteOrigin")
      return reply.code(400).send({ error: "siteOrigin is not an allowed URL" })
    }

    const pages = getSessionPages(scopedSession)
    const slugs = pages.map((page) => page.slug)
    const siteConfig = getSiteConfig(scopedSession)

    const publishCtx: PublishContext = {
      session,
      scopedSession,
      siteId: body.siteId,
      siteOrigin: siteOrigin || undefined,
      pages,
      slugs,
      siteConfig,
      generatedImageDir: ctx.generatedImageDir,
      logger: request.log
    }

    const target = selectPublishTarget(publishCtx)
    if (!target) {
      return reply.code(500).send({ error: "no publish target registered" })
    }

    const outcome = await target.publish(publishCtx)
    publishStatusBySession.set(scopedSession, outcome.tracker)
    if (outcome.ok) setLastPublishedScopedSession(scopedSession)

    return reply.code(outcome.httpStatus).send(outcome.response)
  })

  app.get("/publish/status", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string }
    const session = normalizeSession(query.session)
    const scopedSession = scopedSessionKey(session, query.siteId)
    const current = publishStatusBySession.get(scopedSession)
    if (!current) return reply.code(404).send({ error: "no publish status for session" })
    const refreshed = await refreshPublishStatusFromVercel(current)
    publishStatusBySession.set(scopedSession, refreshed)
    return refreshed
  })

  app.get("/restore/snapshots", async (request, reply) => {
    const query = request.query as { limit?: string; siteId?: string }
    const limit = query.limit ? Number(query.limit) : 30
    const siteId = typeof query.siteId === "string" ? query.siteId.trim() : undefined
    try {
      const snapshots = await listRestoreSnapshots(Number.isFinite(limit) ? limit : 30, siteId || undefined)
      return { snapshots }
    } catch (error) {
      return reply.code(500).send({ error: toErrorDetail(error) })
    }
  })

  app.post("/restore/snapshot", async (request, reply) => {
    const body = (request.body ?? {}) as { commit?: string; session?: string; siteId?: string }
    const commit = typeof body.commit === "string" ? body.commit.trim() : ""
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
      return reply.code(400).send({ error: "commit is required (7-40 hex chars)" })
    }

    const session = normalizeSession(body.session)
    const scopedSession = scopedSessionKey(session, body.siteId)

    try {
      const pages = await loadPublishedSnapshotFromCommit(commit)
      const draft = getSessionDraft(scopedSession)
      draft.clear()
      for (const page of pages) {
        const clone = structuredClone(page)
        ensureHeroImageProps(clone)
        draft.set(clone.slug, clone)
      }
      const previewVersion = bumpVersion(scopedSession)
      markRecentlyRestored(scopedSession)
      schedulePersistState(app.log)
      return {
        status: "restored",
        commit: commit.slice(0, 7),
        session,
        scopedSession,
        slugs: pages.map((page) => page.slug),
        previewVersion
      }
    } catch (error) {
      return reply.code(400).send({ error: toErrorDetail(error) })
    }
  })

  app.delete("/restore/snapshot", async (request, reply) => {
    const body = (request.body ?? {}) as { commit?: string }
    const commit = typeof body.commit === "string" ? body.commit.trim() : ""
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
      return reply.code(400).send({ error: "commit is required (7-40 hex chars)" })
    }
    try {
      const ok = await deletePublishSnapshot(commit)
      if (!ok) return reply.code(400).send({ error: "Failed to delete snapshot." })
      return { status: "deleted", commit }
    } catch (error) {
      return reply.code(500).send({ error: toErrorDetail(error) })
    }
  })
}
