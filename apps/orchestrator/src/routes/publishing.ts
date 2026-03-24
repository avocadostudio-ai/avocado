import type { FastifyInstance } from "fastify"
import {
  type PublishTracker,
  normalizeSession,
  scopedSessionKey,
  publishStatusBySession,
  getSessionPages,
  getSiteConfig,
  getSessionDraft,
  ensureHeroImageProps,
  bumpVersion,
  schedulePersistState,
  setLastPublishedScopedSession
} from "../state/session-state.js"
import { toErrorDetail } from "../ops/ops-engine.js"
import {
  deploymentIdFromAny,
  refreshPublishStatusFromVercel,
  requirePublishToken,
  listRestoreSnapshots,
  loadPublishedSnapshotFromCommit,
  publishViaGit,
  collectInlineAssets,
  recordPublishSnapshot
} from "../publish/publish-helpers.js"
import { firstUrlFromText } from "../chat/chat-pipeline.js"
import { parseJsonMaybe } from "../chat/variation-pipeline.js"
import type { RouteContext } from "./route-context.js"

function findStringByKeys(root: unknown, wanted: Set<string>): string | undefined {
  if (!root || typeof root !== "object") return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findStringByKeys(item, wanted)
      if (found) return found
    }
    return undefined
  }
  const obj = root as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && wanted.has(key)) return value
    if (value && typeof value === "object") {
      const found = findStringByKeys(value, wanted)
      if (found) return found
    }
  }
  return undefined
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
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    // Allow in development
    if (process.env.NODE_ENV === "production") return false
  }
  return true
}

export async function publishingRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post("/publish", async (request, reply) => {
    if (!requirePublishToken(request as { headers: Record<string, unknown> })) {
      return reply.code(401).send({ error: "invalid publish token" })
    }

    const body = (request.body ?? {}) as { session?: string; siteId?: string; siteOrigin?: string }
    const session = normalizeSession(body.session)
    const scopedSession = scopedSessionKey(session, body.siteId)
    const siteOrigin = typeof body.siteOrigin === "string" ? body.siteOrigin.trim().replace(/\/+$/, "") : ""

    if (siteOrigin && !isSafeOrigin(siteOrigin)) {
      return reply.code(400).send({ error: "siteOrigin is not an allowed URL" })
    }

    const pages = getSessionPages(scopedSession)
    const slugs = pages.map((page) => page.slug)

    // Publish via the site's contract endpoint
    if (siteOrigin) {
      const siteConfig = getSiteConfig(scopedSession)
      const assets = await collectInlineAssets(pages, ctx.generatedImageDir)
      let siteRes: Response
      try {
        const publishTokenValue = process.env.PUBLISH_TOKEN?.trim()
        siteRes = await fetch(`${siteOrigin}/api/editor/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(publishTokenValue ? { "x-publish-token": publishTokenValue } : {})
          },
          body: JSON.stringify({
            pages,
            siteConfig,
            session: scopedSession,
            publishedAt: new Date().toISOString(),
            ...(Object.keys(assets).length > 0 ? { assets } : {})
          })
        })
      } catch (err) {
        const detail = err instanceof Error ? err.message : "fetch failed"
        return reply.code(502).send({
          status: "failed",
          session,
          slugs,
          reason: `Site unreachable at ${siteOrigin}/api/editor/publish: ${detail}`
        })
      }

      if (siteRes.status === 404) {
        return reply.code(400).send({
          status: "failed",
          session,
          slugs,
          reason: `Site does not implement the publish contract. POST ${siteOrigin}/api/editor/publish returned 404.`
        })
      }

      const siteResult = (await siteRes.json()) as { ok?: boolean; slugs?: string[]; error?: string }
      const ok = siteRes.ok && siteResult.ok !== false
      const now = new Date().toISOString()

      const tracker: PublishTracker = {
        session,
        status: ok ? "triggered" : "failed",
        startedAt: now,
        updatedAt: now,
        slugs,
        vercelState: ok ? "READY" : "ERROR",
        deployResponse: "site_contract",
        deployStatus: siteRes.status
      }
      publishStatusBySession.set(scopedSession, tracker)
      if (ok) setLastPublishedScopedSession(scopedSession)

      if (!ok) {
        return reply.code(400).send({
          status: "failed",
          session,
          slugs,
          reason: siteResult.error ?? "site publish failed"
        })
      }

      // Record snapshot in git so version history can find it
      void recordPublishSnapshot(scopedSession, pages).catch(() => {})

      const publishedSlugs = siteResult.slugs ?? slugs
      const pageNames = publishedSlugs.map((s) => s === "/" ? "Home" : s.replace(/^\//, ""))
      return {
        status: "ready" as const,
        session,
        slugs: publishedSlugs,
        vercelState: "READY",
        message: `Published ${pageNames.join(", ")} to site.`
      }
    }

    // No siteOrigin provided — use legacy publish modes
    const publishMode = (process.env.PUBLISH_MODE?.trim().toLowerCase() || "git") as "deploy_hook" | "git"

    if (publishMode === "git") {
      const result = await publishViaGit(scopedSession)
      const tracker: PublishTracker = {
        session,
        status: result.status === "failed" ? "failed" : "triggered",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: result.slugs,
        vercelState: result.status === "failed" ? "ERROR" : "READY",
        deployResponse: "git_publish",
        deployStatus: result.status === "failed" ? 500 : 200
      }
      publishStatusBySession.set(scopedSession, tracker)
      if (result.status !== "failed") setLastPublishedScopedSession(scopedSession)

      if (result.status === "failed") {
        return reply.code(400).send({
          status: "failed",
          session,
          slugs: result.slugs,
          reason: result.reason,
          details: result.details
        })
      }

      return {
        status: result.status,
        session,
        slugs: result.slugs,
        branch: result.branch,
        commitSha: result.commitSha,
        message: result.message,
        vercelState: result.vercelState ?? "READY"
      }
    }

    const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
    if (!deployHookUrl) {
      return reply.code(400).send({ error: "VERCEL_DEPLOY_HOOK_URL is not configured" })
    }

    try {
      const hookResponse = await fetch(deployHookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "orchestrator",
          session: scopedSession,
          slugs,
          publishedAt: new Date().toISOString()
        })
      })

      const responseText = await hookResponse.text()
      const responseJson = parseJsonMaybe(responseText)
      const inspectUrl =
        findStringByKeys(responseJson, new Set(["inspectorUrl", "inspectUrl", "url"])) ?? firstUrlFromText(responseText)
      const deploymentId =
        findStringByKeys(responseJson, new Set(["deploymentId", "id"])) ??
        (inspectUrl ? deploymentIdFromAny(inspectUrl) : undefined) ??
        deploymentIdFromAny(responseText)
      const vercelStateRaw =
        findStringByKeys(responseJson, new Set(["state", "readyState", "status"])) ??
        (hookResponse.ok ? "TRIGGERED" : "FAILED")
      const vercelState = typeof vercelStateRaw === "string" ? vercelStateRaw.toUpperCase() : undefined

      const tracker: PublishTracker = {
        session,
        status: hookResponse.ok ? "triggered" : "failed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs,
        deployStatus: hookResponse.status,
        deployResponse: responseText.slice(0, 500),
        inspectUrl,
        deploymentId,
        vercelState
      }
      publishStatusBySession.set(scopedSession, tracker)
      if (hookResponse.ok) setLastPublishedScopedSession(scopedSession)

      return {
        status: hookResponse.ok ? "triggered" : "failed",
        session,
        slugs,
        deployStatus: hookResponse.status,
        deployResponse: responseText.slice(0, 500),
        inspectUrl,
        deploymentId,
        vercelState
      }
    } catch (error) {
      return reply.code(502).send({ error: toErrorDetail(error) })
    }
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
}
