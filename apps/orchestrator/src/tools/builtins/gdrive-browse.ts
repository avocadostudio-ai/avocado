import { listImages, isGdriveConfigured, fileNameToAlt, resolveGdriveFolderId } from "../../image/gdrive-client.js"
import type { ToolManifest, ToolHandler } from "../types.js"

type GdriveBrowseInput = {
  query?: string
  limit?: number
}

type GdriveBrowseResultItem = {
  id: string
  imageUrl: string
  thumbUrl: string
  alt: string
  author: string
  sourceUrl: string
}

export const gdriveBrowseManifest: ToolManifest = {
  name: "gdrive.browse",
  description: "Browse and search images in the shared Google Drive folder. Use for brand assets, company photos, or user-uploaded images.",
  capability: "read",
  timeoutMs: 8000,
  retryPolicy: { maxAttempts: 2, backoffMs: 200 },
  idempotent: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      query: { type: "string", description: "Optional search text to filter images by name" },
      limit: { type: "integer", description: "Max results (1-10, default 5)" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "imageUrl", "thumbUrl", "alt", "author", "sourceUrl"],
          properties: {
            id: { type: "string" },
            imageUrl: { type: "string" },
            thumbUrl: { type: "string" },
            alt: { type: "string" },
            author: { type: "string" },
            sourceUrl: { type: "string" }
          }
        }
      }
    }
  }
}

export const gdriveBrowseHandler: ToolHandler = async ({ input, context }) => {
  if (!isGdriveConfigured() && !context.gdriveFolderId) {
    return { items: [] as GdriveBrowseResultItem[] }
  }

  const typed = (input ?? {}) as GdriveBrowseInput
  const query = typeof typed.query === "string" ? typed.query.trim() : undefined
  const limitRaw = typeof typed.limit === "number" ? typed.limit : 5
  const limit = Math.min(10, Math.max(1, Math.trunc(limitRaw)))

  const folderId = resolveGdriveFolderId(context.gdriveFolderId)
  if (!folderId) return { items: [] as GdriveBrowseResultItem[] }
  const orchestratorPublicOrigin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")

  const files = await listImages(folderId, query, undefined, limit)
  const items: GdriveBrowseResultItem[] = files.map((file) => {
    const imageUrl = `${orchestratorPublicOrigin}/gdrive/images/${file.id}`
    const thumbUrl = imageUrl
    return {
      id: file.id,
      imageUrl,
      thumbUrl,
      alt: fileNameToAlt(file.name),
      author: "Google Drive",
      sourceUrl: `https://drive.google.com/file/d/${file.id}/view`
    }
  })

  return { items }
}
