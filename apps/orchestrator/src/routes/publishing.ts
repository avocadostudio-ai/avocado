import type { FastifyInstance } from "fastify"
import {
  type PublishTracker,
  normalizeSession,
  scopedSessionKey,
  publishStatusBySession,
  getSessionPages,
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
  publishViaGit
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

export async function publishingRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.post("/publish", async (request, reply) => {
    if (!requirePublishToken(request as { headers: Record<string, unknown> })) {
      return reply.code(401).send({ error: "invalid publish token" })
    }

    const body = (request.body ?? {}) as { session?: string; siteId?: string }
    const session = normalizeSession(body.session)
    const scopedSession = scopedSessionKey(session, body.siteId)
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

    const pages = getSessionPages(scopedSession)
    const slugs = pages.map((page) => page.slug)

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
    const query = request.query as { limit?: string }
    const limit = query.limit ? Number(query.limit) : 30
    try {
      const snapshots = await listRestoreSnapshots(Number.isFinite(limit) ? limit : 30)
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
