/**
 * Preview-utility HTTP API.
 *
 *   POST /preview/screenshot — capture a full-page screenshot of a draft URL.
 *
 * The registered site config stores `previewUrl` (e.g. http://localhost:3000).
 * Given a slug, we build `<previewUrl><slug>`, launch a headless browser, and
 * return a base64 JPEG. Primarily consumed by the MCP server so chat-only hosts
 * (Claude Desktop) have a visual feedback channel; the editor iframe remains the
 * real-time preview for the editor UI.
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
    const fullUrl = previewUrl.replace(/\/+$/, "") + normalizedSlug

    try {
      const result = await takeScreenshot(fullUrl)
      return {
        url: fullUrl,
        slug: normalizedSlug,
        mimeType: "image/jpeg" as const,
        base64: result.base64,
        width: result.viewport.width,
        height: result.viewport.height,
      }
    } catch (err) {
      request.log.warn({ err: String(err), fullUrl }, "preview screenshot failed")
      return reply.code(502).send({
        error: `failed to capture screenshot for ${fullUrl}: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  })
}
