import type { InlineAsset } from "./editor-routes.ts"

/**
 * Reject URLs pointing at private/loopback addresses (SSRF protection).
 * Used by CMS publish handlers to validate image URLs before fetching.
 */
export function isSafeImageUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const h = parsed.hostname
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0") return false
  if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/**
 * CMS-specific image upload function.
 * Receives raw bytes + metadata, returns a CMS asset reference (or null on failure).
 */
export type ImageUploader<T> = (bytes: Buffer, fileName: string, mimeType: string) => Promise<T | null>

/**
 * Creates a cached image resolver for use during publish.
 *
 * Handles the full resolution pipeline that every CMS integration needs:
 * 1. Check inline assets (base64 from orchestrator for localhost/generated URLs)
 * 2. SSRF validation
 * 3. Fetch external URL
 * 4. Call CMS-specific upload function
 * 5. Cache results to avoid duplicate uploads within a single publish
 *
 * @param upload  CMS-specific upload function (Sanity asset upload, Contentful asset create, Strapi media upload, etc.)
 * @param assets  Inline assets from the publish context (base64-encoded images)
 * @returns       A `resolve(imageUrl)` function that returns the CMS asset reference or null
 */
export function createImageResolver<T>(
  upload: ImageUploader<T>,
  assets?: Record<string, InlineAsset>
) {
  const cache = new Map<string, Promise<T | null>>()

  function resolve(imageUrl: string): Promise<T | null> {
    const cached = cache.get(imageUrl)
    if (cached) return cached

    const promise = (async (): Promise<T | null> => {
      if (!imageUrl.startsWith("http")) return null

      const inlineAsset = assets?.[imageUrl]
      if (inlineAsset) {
        try {
          const buf = Buffer.from(inlineAsset.data, "base64")
          return await upload(buf, inlineAsset.fileName, inlineAsset.mimeType)
        } catch { return null }
      }

      if (!isSafeImageUrl(imageUrl)) return null

      try {
        const res = await fetch(imageUrl)
        if (!res.ok) return null
        const blob = await res.blob()
        const buf = Buffer.from(await blob.arrayBuffer())
        const fileName = imageUrl.split("/").pop()?.split("?")[0] || "image.jpg"
        const mimeType = blob.type || guessContentType(imageUrl)
        return await upload(buf, fileName, mimeType)
      } catch { return null }
    })()

    cache.set(imageUrl, promise)
    return promise
  }

  return { resolve }
}

function guessContentType(url: string): string {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase()
    if (ext === "png") return "image/png"
    if (ext === "webp") return "image/webp"
    if (ext === "gif") return "image/gif"
    if (ext === "svg") return "image/svg+xml"
  } catch { /* invalid URL — fall through */ }
  return "image/jpeg"
}
