import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { FastifyInstance } from "fastify"
import { pageDocSchemaLenient, siteConfigSchema, type PageDoc, type SiteConfig } from "@ai-site-editor/shared"
import {
  publishedPages,
  scopedSessionKey,
  normalizeSession,
  orderSlugsHomeFirst,
  getSessionDraft,
  getPage,
  getSessionPages,
  getSiteConfig,
  setSiteConfig,
  schedulePersistState,
  ensureHeroImageProps
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

  app.post("/draft/bootstrap", async (request, reply) => {
    const body = (request.body ?? {}) as {
      session?: string
      siteId?: string
      pages?: unknown
      overwrite?: boolean
    }
    const scopedSession = scopedSessionKey(body.session, body.siteId)
    const overwrite = body.overwrite === true
    const draft = getSessionDraft(scopedSession)

    if (!overwrite && draft.size > 0) {
      return { status: "skipped", reason: "already_initialized", slugs: orderSlugsHomeFirst(Array.from(draft.keys())) }
    }

    let sourcePages: PageDoc[] = []
    if (Array.isArray(body.pages) && body.pages.length > 0) {
      const parsed = body.pages
        .map((candidate) => pageDocSchemaLenient.safeParse(candidate))
        .filter((result): result is { success: true; data: PageDoc } => result.success)
        .map((result) => result.data)
      sourcePages = parsed
    } else {
      sourcePages = Array.from(publishedPages.values()).map((page) => structuredClone(page))
    }

    if (sourcePages.length === 0) {
      return reply.code(400).send({ error: "No valid pages to bootstrap." })
    }

    if (overwrite) draft.clear()
    for (const page of sourcePages) {
      const copy = structuredClone(page)
      ensureHeroImageProps(copy)
      draft.set(copy.slug, copy)
    }

    return {
      status: "bootstrapped",
      count: sourcePages.length,
      slugs: orderSlugsHomeFirst(Array.from(draft.keys()))
    }
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

  app.get("/draft/site-config", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string }
    if (!query.session) return reply.code(400).send({ error: "session is required" })
    const session = scopedSessionKey(query.session, query.siteId)
    return getSiteConfig(session)
  })

  app.put("/draft/site-config", async (request, reply) => {
    const body = (request.body ?? {}) as { session?: string; siteId?: string; config?: unknown }
    if (!body.session) return reply.code(400).send({ error: "session is required" })
    const parsed = siteConfigSchema.safeParse(body.config)
    if (!parsed.success) return reply.code(400).send({ error: "invalid config", details: parsed.error.issues })
    const session = scopedSessionKey(body.session, body.siteId)
    setSiteConfig(session, parsed.data)
    schedulePersistState(app.log)
    return { status: "ok", config: getSiteConfig(session) }
  })

  app.get("/publish/content", async (request, reply) => {
    const query = request.query as { session?: string; siteId?: string }
    if (!query.siteId) {
      return reply.code(400).send({ error: "siteId is required" })
    }
    const session = normalizeSession(query.session)
    const scopedSession = scopedSessionKey(session, query.siteId)
    const pages = getSessionPages(scopedSession)
    const siteConfig = getSiteConfig(scopedSession)
    return {
      session,
      slugs: pages.map((page) => page.slug),
      pages,
      siteConfig,
      generatedAt: new Date().toISOString()
    }
  })
}
