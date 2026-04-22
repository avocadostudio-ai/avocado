/**
 * Preview-utility HTTP API.
 *
 *   POST /preview/screenshot — capture a full-page screenshot of a page.
 *
 * The site exposes `/preview-draft/[[...slug]]?session=X&siteId=Y` which
 * renders the orchestrator's draft content directly (no cookie dance — the
 * route reads session + siteId from query params). We target that route by
 * default so screenshots reflect in-progress edits, not just the last
 * published snapshot. Callers can pass `published: true` to screenshot the
 * public route instead (useful for before/after comparisons).
 */

import type { FastifyInstance } from "fastify"
import { takeScreenshot } from "@ai-site-editor/migration-sdk"
import { getSiteConfig, scopedSessionKey } from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

type ScreenshotBody = {
  session?: string
  siteId?: string
  /** Page slug to screenshot — defaults to the home page ("/"). */
  slug?: string
  /** Override the preview URL from the registered site config. */
  previewUrl?: string
  /** Screenshot the published route instead of the draft preview. Defaults to false. */
  published?: boolean
}

export async function previewRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.post("/preview/screenshot", async (request, reply) => {
    const body = (request.body ?? {}) as ScreenshotBody
    if (!body.session) return reply.code(400).send({ error: "session is required" })
    if (!body.siteId) return reply.code(400).send({ error: "siteId is required" })

    const scopedSession = scopedSessionKey(body.session, body.siteId)
    const config = getSiteConfig(scopedSession)
    const previewUrl = body.previewUrl ?? (config as Record<string, unknown>).previewUrl
    if (typeof previewUrl !== "string" || previewUrl.length === 0) {
      return reply.code(400).send({
        error: "no previewUrl configured for this site. Register it first via POST /sites/register or pass `previewUrl` in the body.",
      })
    }

    const slug = body.slug ?? "/"
    // Guard against absolute URLs in `slug` — only allow path-like values.
    if (/^https?:\/\//i.test(slug)) {
      return reply.code(400).send({ error: "slug must be a path, not a full URL" })
    }

    const normalizedSlug = slug.startsWith("/") ? slug : `/${slug}`
    const base = previewUrl.replace(/\/+$/, "")

    // Draft mode: target the site's /preview-draft route so the orchestrator's
    // draft content is rendered directly, without needing a signed cookie.
    // Published mode: hit the plain public route.
    const fullUrl = body.published === true
      ? base + normalizedSlug
      : base
        + "/preview-draft"
        + (normalizedSlug === "/" ? "" : normalizedSlug)
        + `?session=${encodeURIComponent(body.session)}&siteId=${encodeURIComponent(body.siteId)}`

    try {
      const result = await takeScreenshot(fullUrl)
      return {
        url: fullUrl,
        slug: normalizedSlug,
        mode: body.published === true ? "published" : "draft",
        mimeType: "image/jpeg" as const,
        base64: result.base64,
        width: result.viewport.width,
        height: result.viewport.height,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      request.log.warn({ err: message, fullUrl }, "preview screenshot failed")
      return reply.code(502).send({
        error: message,
        url: fullUrl,
        mode: body.published === true ? "published" : "draft",
      })
    }
  })
}
