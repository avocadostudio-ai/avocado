import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { createImageResolver } from "@ai-site-editor/site-sdk/routes"
import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { imageFields } from "./manifest"

/** Check if a URL points to the same Strapi server */
function isStrapiUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const strapiParsed = new URL(STRAPI_URL)
    return parsed.origin === strapiParsed.origin
  } catch { return false }
}

/** Look up an existing Strapi media asset by its URL path, return its ID */
async function findStrapiMediaByUrl(imageUrl: string): Promise<number | null> {
  try {
    const parsed = new URL(imageUrl)
    const urlPath = parsed.pathname
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (process.env.STRAPI_API_TOKEN) headers.Authorization = `Bearer ${process.env.STRAPI_API_TOKEN}`
    const res = await fetch(
      `${STRAPI_URL}/api/upload/files?filters[url][$eq]=${encodeURIComponent(urlPath)}`,
      { headers }
    )
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ id: number }>
    return data[0]?.id ?? null
  } catch { return null }
}

/** Upload a blob to Strapi media library, return the media ID */
async function uploadToStrapiMedia(blob: Blob, fileName: string): Promise<number | null> {
  const form = new FormData()
  form.append("files", blob, fileName)
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST",
    headers: { ...(process.env.STRAPI_API_TOKEN ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` } : {}) },
    body: form,
  })
  if (!res.ok) return null
  const uploaded = (await res.json()) as Array<{ id: number }>
  return uploaded[0]?.id ?? null
}

/**
 * Publish handler for Strapi using Dynamic Zones.
 *
 * Each block is stored as a Strapi Component within the page's
 * Dynamic Zone — the native Strapi way to model page builders.
 * No separate block entries — components are embedded in the page.
 */
export function createStrapiPublishHandler(): OnPublishFn {
  return async (pages, config, context) => {
    // Shared image resolver: handles inline assets, SSRF, fetch, and caching.
    // Strapi-specific: also resolves existing Strapi media URLs by lookup.
    const imageResolver = createImageResolver<number>(
      async (bytes, fileName) => uploadToStrapiMedia(new Blob([bytes]), fileName),
      context?.assets,
    )
    const errors: string[] = []

    // Wrap resolver to also handle Strapi-local URLs (already in media library)
    async function resolveMediaId(imageUrl: string): Promise<number | null> {
      if (!imageUrl.startsWith("http") && imageUrl.startsWith("/")) {
        return findStrapiMediaByUrl(`${STRAPI_URL}${imageUrl}`)
      }
      if (isStrapiUrl(imageUrl)) {
        return findStrapiMediaByUrl(imageUrl)
      }
      return imageResolver.resolve(imageUrl)
    }

    for (const page of pages) {
      try {
        // Find existing page by slug (with populated blocks so we can preserve media)
        const existing = await strapiFetch<{ data: Array<{ documentId: string; blocks?: Array<Record<string, unknown>> }> }>(
          `/pages?filters[slug][$eq]=${encodeURIComponent(page.slug)}&populate[blocks][populate]=*`
        )
        const existingBlocks = existing.data[0]?.blocks as Array<Record<string, unknown>> | undefined

        // Build Dynamic Zone array — each block becomes a component
        const dzBlocks = await Promise.all(page.blocks.map(async (block, blockIndex) => {
          const componentName = `blocks.${block.type.toLowerCase()}`
          const imgFields = imageFields.get(block.type) ?? new Set<string>()
          const data: Record<string, unknown> = {
            __component: componentName,
          }

          for (const [key, value] of Object.entries(block.props)) {
            if (key === "headingLevel") continue
            if (imgFields.has(key) && typeof value === "string" && value) {
              const mediaId = await resolveMediaId(value)
              if (mediaId) {
                data[key] = mediaId
              } else {
                // Preserve existing Strapi media if we couldn't resolve the new image
                const existingMedia = existingBlocks?.[blockIndex]?.[key]
                const existingMediaId = existingMedia && typeof existingMedia === "object" && !Array.isArray(existingMedia)
                  ? (existingMedia as Record<string, unknown>).id as number | undefined
                  : undefined
                if (existingMediaId) {
                  data[key] = existingMediaId
                }
              }
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

    // Delete pages that exist in Strapi but not in the published set
    const publishedSlugs = new Set(pages.map((p) => p.slug))
    try {
      const allCmsPages = await strapiFetch<{ data: Array<{ documentId: string; slug: string }> }>(
        "/pages?fields[0]=slug&fields[1]=documentId&pagination[pageSize]=100"
      )
      for (const cmsPage of allCmsPages.data) {
        if (!publishedSlugs.has(cmsPage.slug)) {
          try {
            await strapiFetch(`/pages/${cmsPage.documentId}`, { method: "DELETE" })
          } catch (err) {
            errors.push(`delete ${cmsPage.slug}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    } catch {
      // Non-fatal — stale pages remain but published pages are correct
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
