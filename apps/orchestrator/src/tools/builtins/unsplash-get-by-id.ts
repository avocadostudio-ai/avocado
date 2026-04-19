/**
 * Resolve an Unsplash photo page URL or bare photo ID to a direct image asset
 * URL via the Unsplash REST API.
 *
 * Reporters frequently drop links like
 *   https://unsplash.com/photos/an-aerial-view-of-lava-in-the-ocean-4c0JJqaG93c
 * which are HTML pages, not image assets. Setting `imageUrl` to those breaks
 * the `<img>` tag. This tool extracts the ID (last token after the final
 * hyphen) and fetches `GET /photos/:id` to get `urls.regular`.
 */

import type { ToolManifest, ToolHandler } from "../types.js"

type UnsplashGetByIdInput = {
  url?: string
  photoId?: string
}

type UnsplashGetByIdResult = {
  imageUrl: string
  alt: string
  author: string
  sourceUrl: string
  photoId: string
}

export const unsplashGetByIdManifest: ToolManifest = {
  name: "unsplash.get_by_id",
  description: "Resolve an Unsplash photo page URL or ID to a direct image asset URL",
  capability: "read",
  timeoutMs: 6000,
  retryPolicy: { maxAttempts: 2, backoffMs: 200 },
  idempotent: true,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: { type: "string", description: "Unsplash photo page URL, e.g. https://unsplash.com/photos/slug-PHOTOID" },
      photoId: { type: "string", description: "Bare Unsplash photo ID (alternative to url)" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["imageUrl", "alt", "author", "sourceUrl", "photoId"],
    properties: {
      imageUrl: { type: "string" },
      alt: { type: "string" },
      author: { type: "string" },
      sourceUrl: { type: "string" },
      photoId: { type: "string" },
    },
  },
}

/**
 * Pull the photo ID out of an Unsplash URL. Supported shapes:
 *   https://unsplash.com/photos/PHOTOID
 *   https://unsplash.com/photos/slug-with-hyphens-PHOTOID
 *   https://unsplash.com/photos/PHOTOID?ixid=...
 *   http(s)://www.unsplash.com/... (www prefix + http tolerated)
 *
 * Returns null when the URL is not an unsplash.com/photos/* link.
 */
export function extractUnsplashPhotoId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // Bare ID path (no slashes, no dots) — just validate shape
  if (!trimmed.includes("/") && !trimmed.includes(".")) {
    return /^[A-Za-z0-9_-]{6,}$/.test(trimmed) ? trimmed : null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!/(^|\.)unsplash\.com$/i.test(url.hostname)) return null

  const segments = url.pathname.split("/").filter(Boolean)
  const photosIdx = segments.indexOf("photos")
  if (photosIdx === -1 || photosIdx === segments.length - 1) return null

  const slug = segments[photosIdx + 1]
  // The photo ID is the trailing token after the last hyphen, or the whole slug
  // if there are no hyphens (bare-ID form).
  const lastHyphen = slug.lastIndexOf("-")
  const candidate = lastHyphen === -1 ? slug : slug.slice(lastHyphen + 1)
  return /^[A-Za-z0-9_-]{6,}$/.test(candidate) ? candidate : null
}

export const unsplashGetByIdHandler: ToolHandler = async ({ input }) => {
  const typed = (input ?? {}) as UnsplashGetByIdInput
  const rawId = typeof typed.photoId === "string" ? typed.photoId.trim() : ""
  const rawUrl = typeof typed.url === "string" ? typed.url.trim() : ""

  const photoId = rawId || (rawUrl ? extractUnsplashPhotoId(rawUrl) : null)
  if (!photoId) {
    throw new Error("Could not extract an Unsplash photo ID from the input. Provide an unsplash.com/photos/... URL or a bare photo ID.")
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim()
  if (!accessKey) {
    throw new Error("UNSPLASH_ACCESS_KEY is not configured on the orchestrator.")
  }

  const endpoint = `https://api.unsplash.com/photos/${encodeURIComponent(photoId)}`
  const res = await fetch(endpoint, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
      "Accept-Version": "v1",
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Unsplash API ${res.status}: ${res.statusText} — ${body.slice(0, 200)}`)
  }

  type UnsplashPhoto = {
    urls?: { regular?: unknown; full?: unknown; raw?: unknown }
    alt_description?: unknown
    description?: unknown
    user?: { name?: unknown }
    links?: { html?: unknown }
  }
  const data = (await res.json()) as UnsplashPhoto

  const base =
    typeof data.urls?.regular === "string" ? data.urls.regular
    : typeof data.urls?.full === "string" ? data.urls.full
    : typeof data.urls?.raw === "string" ? data.urls.raw
    : ""
  if (!base) throw new Error("Unsplash response did not include a usable image URL.")

  const joiner = base.includes("?") ? "&" : "?"
  const imageUrl = `${base}${joiner}auto=format&fit=crop&w=1600&q=80`

  const altRaw =
    typeof data.alt_description === "string" ? data.alt_description
    : typeof data.description === "string" ? data.description
    : ""

  const result: UnsplashGetByIdResult = {
    imageUrl,
    alt: altRaw.trim() || "Unsplash photo",
    author: typeof data.user?.name === "string" ? data.user.name : "Unsplash",
    sourceUrl: typeof data.links?.html === "string" ? data.links.html : `https://unsplash.com/photos/${photoId}`,
    photoId,
  }
  return result
}
