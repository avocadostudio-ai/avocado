import type { FastifyInstance, FastifyBaseLogger } from "fastify"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { PageDoc, SiteConfig } from "@avocadostudio-ai/shared"
import {
  normalizeSession,
  normalizeSiteId,
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
  publishedPages,
  pushPublishLogEntry,
  updatePublishLogStatusById,
  findPublishLogForStatusUpdate,
  listPublishLog,
} from "../state/session-state.js"
import type { PublishLogEntry, PublishLogStatus } from "../state/session-state.js"
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
async function readPublishedJsonFile(): Promise<{ pages: PageDoc[] | null; siteConfig: SiteConfig | null }> {
  const paths: string[] = []
  if (process.env.PUBLISHED_CONTENT_PATH?.trim()) paths.push(process.env.PUBLISHED_CONTENT_PATH.trim())
  // Monorepo default — orchestrator cwd is apps/orchestrator in dev.
  paths.push(resolve(process.cwd(), "../../apps/site/lib/published-content.json"))
  paths.push(resolve(process.cwd(), "../site/lib/published-content.json"))

  for (const path of paths) {
    try {
      const raw = await readFile(path, "utf8")
      const parsed = JSON.parse(raw) as { pages?: PageDoc[]; siteConfig?: SiteConfig } | PageDoc[]
      if (Array.isArray(parsed)) {
        return { pages: parsed, siteConfig: null }
      }
      if (Array.isArray(parsed.pages)) {
        return { pages: parsed.pages, siteConfig: parsed.siteConfig ?? null }
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { pages: null, siteConfig: null }
}

async function loadPublishedForDiff(opts: {
  siteOrigin?: string
  logger: FastifyBaseLogger
}): Promise<{ pages: PageDoc[]; siteConfig: SiteConfig | null }> {
  const { siteOrigin, logger } = opts

  let remotePages: PageDoc[] | null = null
  let remoteSiteConfig: SiteConfig | null = null

  if (siteOrigin) {
    try {
      const res = await fetch(`${siteOrigin.replace(/\/+$/, "")}/api/editor/pages`, {
        headers: { accept: "application/json" },
      })
      if (res.ok) {
        const data = (await res.json()) as { pages?: PageDoc[]; siteConfig?: SiteConfig }
        if (Array.isArray(data.pages)) {
          remotePages = data.pages
          remoteSiteConfig = data.siteConfig ?? null
        }
      } else {
        logger.warn({ siteOrigin, status: res.status }, "publish/diff: site pages endpoint not ok, falling back")
      }
    } catch (err) {
      logger.warn({ siteOrigin, err: String(err) }, "publish/diff: site fetch failed, falling back")
    }
  }

  // Hot path: remote returned both pages and siteConfig.
  if (remotePages && remoteSiteConfig) {
    return { pages: remotePages, siteConfig: remoteSiteConfig }
  }

  // Either the remote didn't run, didn't include siteConfig (older SDK or
  // site dev not yet restarted), or didn't include pages. Read the JSON file
  // to backfill the missing pieces — without it, a missing siteConfig would
  // be misread as "header added · all fields" on every publish-diff load.
  const fromFile = await readPublishedJsonFile()
  const pages = remotePages ?? fromFile.pages
  const siteConfig = remoteSiteConfig ?? fromFile.siteConfig
  if (pages) return { pages, siteConfig }

  logger.warn("publish/diff: falling back to in-memory publishedPages — diff may be inaccurate")
  return { pages: Array.from(publishedPages.values()), siteConfig }
}

function slugToTitle(slug: string): string {
  return slug === "/" ? "Home" : slug.replace(/^\//, "")
}

/**
 * Build a short human-readable summary of what was published, biased toward
 * *changes* rather than the full site contents. Falls back to "republished N
 * pages" when no diff is available.
 */
function buildPublishSummary(opts: {
  changedSlugs: string[]
  removedSlugs: string[]
  totalPages: number
  hasDiff: boolean
}): string {
  const { changedSlugs, removedSlugs, totalPages, hasDiff } = opts
  if (totalPages === 0 && removedSlugs.length === 0) return "Published (no pages)"
  if (!hasDiff) {
    return `Republished ${totalPages} ${totalPages === 1 ? "page" : "pages"}`
  }
  if (changedSlugs.length === 0 && removedSlugs.length === 0) {
    return "Republished — no content changes"
  }
  const titles = changedSlugs.map(slugToTitle)
  const removed = removedSlugs.map(slugToTitle)
  const parts: string[] = []
  if (titles.length === 1) parts.push(`Published ${titles[0]}`)
  else if (titles.length === 2) parts.push(`Published ${titles[0]} and ${titles[1]}`)
  else if (titles.length === 3) parts.push(`Published ${titles.join(", ")}`)
  else if (titles.length > 0) parts.push(`Published ${titles.slice(0, 2).join(", ")} +${titles.length - 2} more`)
  if (removed.length === 1) parts.push(`removed ${removed[0]}`)
  else if (removed.length > 1) parts.push(`removed ${removed.length} pages`)
  return parts.join(", ") || `Republished ${totalPages} pages`
}

/** Coerce a publish target's response (`Record<string, unknown>`) into a typed read. */
function readResponseString(response: Record<string, unknown>, key: string): string | undefined {
  const value = response[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Map a refreshed Vercel `vercelState` to a publish-log status. READY counts
 * as success; ERROR/CANCELED count as failed. Any other state (BUILDING,
 * QUEUED, INITIALIZING, UNKNOWN, …) leaves the row at `triggered`.
 */
function publishStatusFromVercelState(state: string | undefined): PublishLogStatus | null {
  if (!state) return null
  const upper = state.toUpperCase()
  if (upper === "READY") return "success"
  if (upper === "ERROR" || upper === "CANCELED") return "failed"
  return null
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
    const draftSiteConfig = getSiteConfig(scopedSession)
    const { pages: published, siteConfig: publishedSiteConfig } = await loadPublishedForDiff({
      siteOrigin: query.siteOrigin,
      logger: app.log,
    })
    return computePublishDiff(draft, published, {
      draftSiteConfig,
      publishedSiteConfig,
    })
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

    // Compute diff vs the currently-published state *before* the target runs,
    // otherwise re-reading after the push would show empty. Tolerant: if the
    // diff fails, we fall back to a coarse "republished N pages" summary.
    let changedSlugs: string[] = []
    let removedSlugs: string[] = []
    let addedCount = 0
    let modifiedCount = 0
    let hasDiff = false
    try {
      const { pages: publishedBefore, siteConfig: publishedSiteConfig } = await loadPublishedForDiff({
        siteOrigin: siteOrigin || undefined,
        logger: request.log,
      })
      const diff = computePublishDiff(pages, publishedBefore, {
        draftSiteConfig: siteConfig,
        publishedSiteConfig,
      })
      for (const p of diff.pages) {
        if (p.status === "added") {
          changedSlugs.push(p.slug)
          addedCount++
        } else if (p.status === "modified") {
          changedSlugs.push(p.slug)
          modifiedCount++
        } else if (p.status === "removed") {
          removedSlugs.push(p.slug)
        }
      }
      hasDiff = true
    } catch (err) {
      request.log.warn({ err: String(err) }, "publish: diff pre-computation failed")
    }

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

    // Persist a publish-log row regardless of success. On success the row is
    // born as "triggered" — the deploy itself is still in flight on Vercel's
    // side, and `GET /publish/status` matures the row to "success" or
    // "failed" when `vercelState` resolves. On synchronous failure (e.g. the
    // target threw, or the deploy hook URL is missing) we record "failed"
    // immediately with the error from the response.
    // Synchronous targets (site-contract, git) finish the moment POST returns
    // and set `vercelState: "READY"` in the tracker. Only deploy-hook style
    // targets leave the build pending on Vercel's side — those land here with
    // a non-terminal vercelState (TRIGGERED/BUILDING/etc.) and rely on a
    // later GET /publish/status to mature the row.
    const initialStatus: PublishLogStatus = !outcome.ok
      ? "failed"
      : publishStatusFromVercelState(outcome.tracker.vercelState) ?? "triggered"

    try {
      pushPublishLogEntry({
        session: scopedSession,
        siteId: normalizeSiteId(body.siteId),
        target: target.name,
        status: initialStatus,
        summary: outcome.ok
          ? buildPublishSummary({
              changedSlugs,
              removedSlugs,
              totalPages: pages.length,
              hasDiff,
            })
          : readResponseString(outcome.response, "error") ?? outcome.tracker.lastCheckError ?? "Publish failed",
        pageCount: pages.length,
        slugs,
        commit: readResponseString(outcome.response, "commitSha"),
        deploymentId: outcome.tracker.deploymentId,
        deploymentUrl: outcome.tracker.deploymentUrl,
        inspectUrl: outcome.tracker.inspectUrl,
        error: outcome.ok ? undefined : readResponseString(outcome.response, "error") ?? outcome.tracker.lastCheckError,
        diffSummary: hasDiff
          ? {
              added: addedCount,
              removed: removedSlugs.length,
              changed: modifiedCount,
            }
          : undefined,
      })
    } catch (logErr) {
      request.log.error({ err: logErr }, "publish-log: failed to record entry")
    }

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

    // Mature the publish-log row when Vercel reports a terminal state. Falls
    // back to the most-recent "triggered" row when the deployment id is
    // missing (deploy-hook targets that don't parse one out of their response).
    const terminalStatus = publishStatusFromVercelState(refreshed.vercelState)
    if (terminalStatus) {
      const target = findPublishLogForStatusUpdate(scopedSession, refreshed.deploymentId)
      if (target && target.status === "triggered") {
        updatePublishLogStatusById(target.id, {
          status: terminalStatus,
          deploymentId: refreshed.deploymentId ?? target.deploymentId,
          deploymentUrl: refreshed.deploymentUrl ?? target.deploymentUrl,
          inspectUrl: refreshed.inspectUrl ?? target.inspectUrl,
          error: terminalStatus === "failed" ? refreshed.lastCheckError ?? `vercel_state_${refreshed.vercelState}` : undefined,
        })
      }
    }

    return refreshed
  })

  app.get("/publish/log", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string; limit?: string }
    if (!query.session) return reply.code(400).send({ error: "session is required" })
    const scopedSession = scopedSessionKey(normalizeSession(query.session), query.siteId)
    const requested = query.limit ? Number(query.limit) : 50
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, requested)) : 50
    const entries: PublishLogEntry[] = listPublishLog(scopedSession, limit)
    return { entries }
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
