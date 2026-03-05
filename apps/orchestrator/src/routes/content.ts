import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { FastifyInstance } from "fastify"
import {
  publishedPages,
  scopedSessionKey,
  normalizeSession,
  orderSlugsHomeFirst,
  getSessionDraft,
  getPage,
  getSessionPages
} from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

export async function contentRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/published/pages", async (request, reply) => {
    const query = request.query as { slug?: string }
    if (!query.slug) return reply.code(400).send({ error: "slug is required" })

    const page = publishedPages.get(query.slug)
    if (!page) return reply.code(404).send({ error: "not found" })
    return structuredClone(page)
  })

  app.get("/draft/pages", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string; slug?: string }
    if (!query.slug || !query.session) return reply.code(400).send({ error: "session and slug are required" })
    const session = scopedSessionKey(query.session, query.siteId)

    const page = getPage(session, query.slug)
    if (!page) return reply.code(404).send({ error: "not found" })

    return structuredClone(page)
  })

  app.get("/draft/slugs", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string }
    const session = scopedSessionKey(query.session, query.siteId)
    const draft = getSessionDraft(session)
    const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
    return { slugs }
  })

  app.get("/generated-images/:fileName", async (request, reply) => {
    const params = request.params as { fileName?: string }
    const fileName = typeof params.fileName === "string" ? params.fileName.trim() : ""
    const match = fileName.match(/^([a-zA-Z0-9_-]+)\.(png|jpg|jpeg|webp|gif)$/i)
    if (!match) {
      return reply.code(400).send({ error: "invalid filename" })
    }

    try {
      const bytes = await readFile(resolve(ctx.generatedImageDir, fileName))
      const ext = match[2].toLowerCase()
      const contentType = ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "webp"
          ? "image/webp"
          : ext === "gif"
            ? "image/gif"
            : "image/png"
      reply.header("content-type", contentType)
      reply.header("cache-control", "public, max-age=31536000, immutable")
      return reply.send(bytes)
    } catch {
      return reply.code(404).send({ error: "not found" })
    }
  })

  app.get("/publish/content", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string }
    const session = normalizeSession(query.session)
    const scopedSession = scopedSessionKey(session, query.siteId)
    const pages = getSessionPages(scopedSession)
    return {
      session,
      slugs: pages.map((page) => page.slug),
      pages,
      generatedAt: new Date().toISOString()
    }
  })
}
