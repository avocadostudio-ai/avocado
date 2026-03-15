import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import type { FastifyInstance } from "fastify"
import { listImages, downloadImage, isGdriveConfigured, resolveGdriveFolderId } from "../image/gdrive-client.js"
import type { RouteContext } from "./route-context.js"

export async function gdriveRoutes(app: FastifyInstance, ctx: RouteContext) {
  // GET /gdrive/images — list images for the editor picker
  app.get("/gdrive/images", async (request, reply) => {
    if (!isGdriveConfigured()) {
      return reply.code(404).send({ error: "Google Drive not configured" })
    }

    const query = request.query as { q?: string; limit?: string; folderId?: string }
    const folderId = resolveGdriveFolderId(query.folderId)!
    const limitRaw = query.limit ? Number(query.limit) : 20
    const limit = Math.min(50, Math.max(1, Math.trunc(limitRaw)))
    const searchQuery = typeof query.q === "string" ? query.q.trim() : undefined

    const files = await listImages(folderId, searchQuery || undefined, app.log, limit)
    const items = files.map((file) => ({
      id: file.id,
      name: file.name,
      thumbUrl: `${ctx.orchestratorPublicOrigin}/gdrive/images/${file.id}`,
      mimeType: file.mimeType
    }))

    return { items }
  })

  // GET /gdrive/images/:fileId — download, optimize, and serve a Drive image
  app.get("/gdrive/images/:fileId", async (request, reply) => {
    const params = request.params as { fileId?: string }
    const fileId = typeof params.fileId === "string" ? params.fileId.trim() : ""

    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return reply.code(400).send({ error: "invalid fileId" })
    }

    if (!isGdriveConfigured()) {
      return reply.code(404).send({ error: "Google Drive not configured" })
    }

    const result = await downloadImage(fileId, app.log)
    if (!result) {
      return reply.code(404).send({ error: "Image not found or could not be downloaded" })
    }

    try {
      const bytes = await readFile(resolve(ctx.generatedImageDir, result.fileName))
      reply.header("content-type", "image/webp")
      reply.header("cache-control", "public, max-age=31536000, immutable")
      return reply.send(bytes)
    } catch {
      return reply.code(404).send({ error: "not found" })
    }
  })
}
