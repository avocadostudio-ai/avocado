import { imageKeywordsFromQuery, resolveUnsplashImage } from "../../image/image-helpers.js"
import type { ToolManifest, ToolHandler } from "../types.js"

type UnsplashSearchInput = {
  query: string
  limit?: number
}

type UnsplashSearchResultItem = {
  id: string
  imageUrl: string
  thumbUrl: string
  alt: string
  author: string
  sourceUrl: string
}

export const unsplashSearchManifest: ToolManifest = {
  name: "unsplash.search",
  description: "Search Unsplash for candidate photos relevant to a query",
  capability: "read",
  timeoutMs: 6000,
  retryPolicy: { maxAttempts: 2, backoffMs: 150 },
  idempotent: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Natural-language photo search query" },
      limit: { type: "integer", description: "Maximum number of candidates to return (1-5)" }
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

function mapResultToCandidate(url: string, alt: string): UnsplashSearchResultItem {
  const sanitizedAlt = alt.trim() || "Unsplash image"
  const id = url.replace(/[^a-zA-Z0-9]/g, "").slice(-18) || `img_${Date.now()}`
  const thumbUrl = url.includes("?") ? `${url}&w=480&q=70` : `${url}?w=480&q=70`
  const sourceUrl = url.includes("unsplash.com") ? url : `https://unsplash.com/s/photos/${encodeURIComponent(sanitizedAlt)}`
  return {
    id,
    imageUrl: url,
    thumbUrl,
    alt: sanitizedAlt,
    author: "Unsplash",
    sourceUrl
  }
}

export const unsplashSearchHandler: ToolHandler = async ({ input }) => {
  const typed = (input ?? {}) as UnsplashSearchInput
  const query = typeof typed.query === "string" ? typed.query.trim() : ""
  const limitRaw = typeof typed.limit === "number" ? typed.limit : 3
  const limit = Math.min(5, Math.max(1, Math.trunc(limitRaw)))
  const usedImageUrls = new Set<string>()

  if (!query) return { items: [] as UnsplashSearchResultItem[] }

  const items: UnsplashSearchResultItem[] = []
  const keywords = imageKeywordsFromQuery(query, 4)

  for (let idx = 0; idx < limit; idx += 1) {
    const resolved = await resolveUnsplashImage(
      query,
      { variationIndex: idx, usedImageUrls, subjectKeywords: keywords },
      undefined
    )
    if (!resolved) continue
    usedImageUrls.add(resolved.url)
    items.push(mapResultToCandidate(resolved.url, resolved.alt))
  }

  return { items }
}
