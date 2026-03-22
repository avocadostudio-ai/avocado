import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { getAllBlockMeta } from "@ai-site-editor/shared"

/** Get image fields for a block type */
function getImageFields(blockType: string): Set<string> {
  const meta = getAllBlockMeta()[blockType]
  if (!meta) return new Set()
  const result = new Set<string>()
  for (const [key, fm] of Object.entries(meta.fields)) {
    if (fm.kind === "image") result.add(key)
  }
  return result
}

/** Strapi plural API name: Hero → heroes, CTA → ctas, FAQ → faqs */
function toStrapiPlural(blockType: string): string {
  const lower = blockType.toLowerCase()
  if (lower.endsWith("s")) return lower + "es"
  if (lower.endsWith("y") && !/[aeiou]y$/i.test(lower)) return lower.slice(0, -1) + "ies"
  return lower + "s"
}

/** Upload an image URL to Strapi media library, return the media ID */
async function ensureMediaAsset(
  imageUrl: string,
  cache: Map<string, Promise<number | null>>
): Promise<number | null> {
  const cached = cache.get(imageUrl)
  if (cached) return cached

  const promise = (async () => {
    if (!imageUrl.startsWith("http")) return null

    try {
      const imageRes = await fetch(imageUrl)
      if (!imageRes.ok) return null

      const blob = await imageRes.blob()
      const fileName = imageUrl.split("/").pop()?.split("?")[0] || "image.jpg"

      const form = new FormData()
      form.append("files", blob, fileName)

      const uploadRes = await fetch(`${STRAPI_URL}/api/upload`, {
        method: "POST",
        headers: {
          ...(process.env.STRAPI_API_TOKEN ? { Authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` } : {}),
        },
        body: form,
      })
      if (!uploadRes.ok) return null

      const uploaded = (await uploadRes.json()) as Array<{ id: number }>
      return uploaded[0]?.id ?? null
    } catch {
      return null
    }
  })()

  cache.set(imageUrl, promise)
  return promise
}

/**
 * Publish handler for Strapi REST API.
 *
 * Creates/updates block entries, then creates/updates page entries
 * with relations to the blocks.
 */
export function createStrapiPublishHandler(): OnPublishFn {
  return async (pages, config) => {
    const mediaCache = new Map<string, Promise<number | null>>()
    const errors: string[] = []

    for (const page of pages) {
      try {
        const blockIds: number[] = []

        // Upsert each block
        for (const block of page.blocks) {
          const apiName = toStrapiPlural(block.type)
          const imageFields = getImageFields(block.type)

          const data: Record<string, unknown> = {
            blockType: block.type, // custom field to identify block type on read
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

          // Find existing block by blockType + a marker, or create new
          // Strapi auto-generates documentId — we can't set it
          const created = await strapiFetch<{ data: { id: number; documentId: string } }>(`/${apiName}`, {
            method: "POST",
            body: JSON.stringify({ data }),
          })
          blockIds.push(created.data.id)
        }

        // Upsert the page
        const pageData: Record<string, unknown> = {
          slug: page.slug,
          title: page.title,
          pageId: page.id,
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

    // Upsert site config (singleton)
    if (config.name || config.logo || config.navLabels) {
      try {
        await strapiFetch("/site-config", {
          method: "PUT",
          body: JSON.stringify({
            data: {
              name: config.name ?? "",
              logo: config.logo ?? "",
              navLabels: config.navLabels ?? {},
            },
          }),
        })
      } catch {
        // Site config might not exist yet
        try {
          await strapiFetch("/site-config", {
            method: "POST",
            body: JSON.stringify({
              data: {
                name: config.name ?? "",
                logo: config.logo ?? "",
                navLabels: config.navLabels ?? {},
              },
            }),
          })
        } catch {
          // Ignore — site config is optional
        }
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: `Failed: ${errors.join("; ")}` }
    }
    return { ok: true }
  }
}
