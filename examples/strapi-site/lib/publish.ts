import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { getImageFields } from "@ai-site-editor/shared"

/** Reject URLs pointing at private/loopback addresses (SSRF protection) */
function isSafeImageUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const h = parsed.hostname
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0") return false
  if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/** Upload an image URL to Strapi media library, return the media ID */
async function ensureMediaAsset(
  imageUrl: string,
  cache: Map<string, Promise<number | null>>
): Promise<number | null> {
  const cached = cache.get(imageUrl)
  if (cached) return cached

  const promise = (async () => {
    if (!imageUrl.startsWith("http") || !isSafeImageUrl(imageUrl)) return null
    try {
      const imageRes = await fetch(imageUrl)
      if (!imageRes.ok) return null
      const blob = await imageRes.blob()
      const fileName = imageUrl.split("/").pop()?.split("?")[0] || "image.jpg"
      const form = new FormData()
      form.append("files", blob, fileName)
      const uploadRes = await fetch(`${STRAPI_URL}/api/upload`, {
        method: "POST",
        headers: { ...(process.env.STRAPI_API_TOKEN ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` } : {}) },
        body: form,
      })
      if (!uploadRes.ok) return null
      const uploaded = (await uploadRes.json()) as Array<{ id: number }>
      return uploaded[0]?.id ?? null
    } catch { return null }
  })()

  cache.set(imageUrl, promise)
  return promise
}

/**
 * Publish handler for Strapi using Dynamic Zones.
 *
 * Each block is stored as a Strapi Component within the page's
 * Dynamic Zone — the native Strapi way to model page builders.
 * No separate block entries — components are embedded in the page.
 */
export function createStrapiPublishHandler(): OnPublishFn {
  return async (pages, config) => {
    const mediaCache = new Map<string, Promise<number | null>>()
    const errors: string[] = []

    for (const page of pages) {
      try {
        // Build Dynamic Zone array — each block becomes a component
        const dzBlocks = await Promise.all(page.blocks.map(async (block) => {
          const componentName = `blocks.${block.type.toLowerCase()}`
          const imageFields = getImageFields(block.type)
          const data: Record<string, unknown> = {
            __component: componentName,
          }

          for (const [key, value] of Object.entries(block.props)) {
            if (key === "headingLevel") continue
            if (imageFields.has(key) && typeof value === "string" && value) {
              const mediaId = await ensureMediaAsset(value, mediaCache)
              if (mediaId) data[key] = mediaId
            } else {
              data[key] = value
            }
          }

          return data
        }))

        // Upsert the page with Dynamic Zone blocks
        const pageData = {
          slug: page.slug,
          title: page.title,
          pageId: page.id,
          blocks: dzBlocks,
          ...(page.meta ? { pageMeta: page.meta } : {}),
        }

        // Find existing page by slug
        const existing = await strapiFetch<{ data: Array<{ documentId: string }> }>(
          `/pages?filters[slug][$eq]=${encodeURIComponent(page.slug)}`
        )

        if (existing.data.length > 0) {
          await strapiFetch(`/pages/${existing.data[0].documentId}`, {
            method: "PUT",
            body: JSON.stringify({ data: pageData }),
          })
        } else {
          await strapiFetch("/pages", {
            method: "POST",
            body: JSON.stringify({ data: pageData }),
          })
        }
      } catch (err) {
        errors.push(`${page.slug}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Upsert site config
    if (config.name || config.logo || config.navLabels) {
      try {
        await strapiFetch("/site-config", {
          method: "PUT",
          body: JSON.stringify({ data: { name: config.name ?? "", logo: config.logo ?? "", navLabels: config.navLabels ?? {} } }),
        })
      } catch {
        try {
          await strapiFetch("/site-config", {
            method: "POST",
            body: JSON.stringify({ data: { name: config.name ?? "", logo: config.logo ?? "", navLabels: config.navLabels ?? {} } }),
          })
        } catch { /* optional */ }
      }
    }

    if (errors.length > 0) return { ok: false, error: `Failed: ${errors.join("; ")}` }
    return { ok: true }
  }
}
