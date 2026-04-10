import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { createImageResolver } from "@ai-site-editor/site-sdk/routes"
import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { imageFields, listImageFields, listFieldNames } from "./manifest"

/** A Strapi media upload: id for scalar component fields, absolute URL for JSON list items. */
type StrapiMedia = { id: number; url: string }

/** Convert a Strapi-relative media URL (`/uploads/...`) into an absolute URL. */
function toAbsoluteMediaUrl(url: string): string {
  if (!url) return ""
  return url.startsWith("http") ? url : `${STRAPI_URL}${url}`
}

/** Check if a URL points to the same Strapi server */
function isStrapiUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const strapiParsed = new URL(STRAPI_URL)
    return parsed.origin === strapiParsed.origin
  } catch { return false }
}

/** Look up an existing Strapi media asset by its URL path. */
async function findStrapiMediaByUrl(imageUrl: string): Promise<StrapiMedia | null> {
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
    const data = (await res.json()) as Array<{ id: number; url: string }>
    const hit = data[0]
    return hit ? { id: hit.id, url: toAbsoluteMediaUrl(hit.url) } : null
  } catch { return null }
}

/** Upload a blob to Strapi media library, return the created media record. */
async function uploadToStrapiMedia(blob: Blob, fileName: string): Promise<StrapiMedia | null> {
  const form = new FormData()
  form.append("files", blob, fileName)
  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST",
    headers: { ...(process.env.STRAPI_API_TOKEN ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` } : {}) },
    body: form,
  })
  if (!res.ok) return null
  const uploaded = (await res.json()) as Array<{ id: number; url: string }>
  const hit = uploaded[0]
  return hit ? { id: hit.id, url: toAbsoluteMediaUrl(hit.url) } : null
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
    const imageResolver = createImageResolver<StrapiMedia>(
      // `new Uint8Array(bytes)` copies into a fresh ArrayBuffer — Blob is strict
      // about ArrayBufferLike variants and rejects Buffers backed by SharedArrayBuffer.
      async (bytes, fileName) => uploadToStrapiMedia(new Blob([new Uint8Array(bytes)]), fileName),
      context?.assets,
    )
    const errors: string[] = []

    // Wrap resolver to also handle Strapi-local URLs (already in media library).
    // Returns { id, url } so callers can use `id` for component scalar fields
    // and `url` when embedding into JSON list items.
    async function resolveMedia(imageUrl: string): Promise<StrapiMedia | null> {
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
          const listItemImgFields = listImageFields.get(block.type) ?? new Map<string, Set<string>>()
          const listFields = listFieldNames.get(block.type) ?? new Set<string>()
          const existingBlock = existingBlocks?.[blockIndex]
          const data: Record<string, unknown> = {
            __component: componentName,
          }

          for (const [key, value] of Object.entries(block.props)) {
            if (key === "headingLevel") continue

            if (imgFields.has(key) && typeof value === "string" && value) {
              // Scalar image — store as Strapi media id reference
              const media = await resolveMedia(value)
              if (media) {
                data[key] = media.id
              } else {
                // Preserve existing Strapi media if we couldn't resolve the new image
                const existingMedia = existingBlock?.[key]
                const existingMediaId = existingMedia && typeof existingMedia === "object" && !Array.isArray(existingMedia)
                  ? (existingMedia as Record<string, unknown>).id as number | undefined
                  : undefined
                if (existingMediaId) {
                  data[key] = existingMediaId
                }
              }
            } else if (listFields.has(key) && Array.isArray(value)) {
              const itemImgKeys = listItemImgFields.get(key)
              if (itemImgKeys && itemImgKeys.size > 0) {
                // List with image fields inside items (Gallery.items, Carousel.items,
                // Testimonials.items, CardGrid.cards): upload each image and embed the
                // resulting absolute URL in place of the original URL string.
                const prevItems = Array.isArray(existingBlock?.[key]) ? existingBlock[key] as Record<string, unknown>[] : undefined
                data[key] = await Promise.all(
                  (value as Record<string, unknown>[]).map(async (item, i) => {
                    const out: Record<string, unknown> = { ...item }
                    for (const imgKey of itemImgKeys) {
                      const imgUrl = item[imgKey]
                      if (typeof imgUrl !== "string" || !imgUrl) continue
                      const media = await resolveMedia(imgUrl)
                      if (media?.url) {
                        out[imgKey] = media.url
                      } else {
                        // Fallback to the previously published URL at the same index
                        const prevUrl = prevItems?.[i]?.[imgKey]
                        if (typeof prevUrl === "string") out[imgKey] = prevUrl
                      }
                    }
                    return out
                  })
                )
              } else {
                data[key] = value
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

    // NOTE: publish is intentionally additive only.
    //
    // A delete-sync loop here would wipe any Strapi page whose slug isn't in
    // the current publish payload, which is catastrophic when the orchestrator
    // draft is partial — e.g. bootstrap ran before Strapi was reachable, or a
    // prior `/draft/bootstrap` call overwrote with fewer slugs. Contentful and
    // Sanity handlers also leave orphans in place; if a page needs to be
    // deleted, do it from the CMS admin (or add an explicit delete op).

    // Upsert site config
    const hasConfig =
      config.name ||
      config.logo ||
      config.purpose ||
      config.tone ||
      (config.constraints && config.constraints.length > 0) ||
      config.navLabels ||
      config.navGroups ||
      config.themeOverrides
    if (hasConfig) {
      const configData = {
        name: config.name ?? "",
        logo: config.logo ?? "",
        purpose: config.purpose ?? "",
        tone: config.tone ?? "",
        constraints: config.constraints ?? [],
        navLabels: config.navLabels ?? {},
        navGroups: config.navGroups ?? {},
        themeOverrides: config.themeOverrides ?? {},
      }
      try {
        await strapiFetch("/site-config", {
          method: "PUT",
          body: JSON.stringify({ data: configData }),
        })
      } catch {
        try {
          await strapiFetch("/site-config", {
            method: "POST",
            body: JSON.stringify({ data: configData }),
          })
        } catch { /* optional */ }
      }
    }

    if (errors.length > 0) return { ok: false, error: `Failed: ${errors.join("; ")}` }
    return { ok: true }
  }
}
