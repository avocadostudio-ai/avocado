import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { writeClient } from "./sanity.client"
import { toSanityName, getImageFields } from "./sanity.utils"

/** Reject URLs pointing at private/loopback addresses. */
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

/** Upload an image URL as a Sanity asset, return the asset reference */
type SanityImageRef = { _type: "image"; asset: { _type: "reference"; _ref: string } }

async function ensureImageAsset(
  imageUrl: string,
  cache: Map<string, Promise<SanityImageRef | null>>
) {
  const cached = cache.get(imageUrl)
  if (cached) return cached

  const promise = (async () => {
    // Skip non-http URLs — can't upload relative paths as assets
    if (!imageUrl.startsWith("http")) return null
    if (!isSafeImageUrl(imageUrl)) return null

    const res = await fetch(imageUrl)
    if (!res.ok) return null

    const blob = await res.blob()
    const fileName = imageUrl.split("/").pop()?.split("?")[0] || "image.jpg"
    const asset = await writeClient.assets.upload("image", blob, { filename: fileName })

    return {
      _type: "image" as const,
      asset: { _type: "reference" as const, _ref: asset._id },
    }
  })()

  cache.set(imageUrl, promise)
  return promise
}

/**
 * Publish handler using Sanity transactions (all-or-nothing).
 *
 * Each block becomes a Sanity document (type = lowercase block type).
 * Pages reference blocks via an array of references.
 * Images are uploaded as Sanity assets.
 */
export function createSanityPublishHandler(): OnPublishFn {
  return async (pages, config) => {
    const imageCache = new Map<string, Promise<SanityImageRef | null>>()
    const tx = writeClient.transaction()

    for (const page of pages) {
      const blockRefs: Array<{ _type: "reference"; _ref: string; _key: string }> = []

      for (const block of page.blocks) {
        const blockId = `block-${block.id}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
        const blockType = toSanityName(block.type)
        const imageFields = getImageFields(block.type)

        const doc: Record<string, unknown> = {
          _id: blockId,
          _type: blockType,
        }

        for (const [key, value] of Object.entries(block.props)) {
          if (key === "headingLevel") continue

          if (imageFields.has(key) && typeof value === "string" && value) {
            const imageRef = await ensureImageAsset(value, imageCache)
            if (imageRef) doc[key] = imageRef
            // Skip field if image couldn't be uploaded (non-http URL)
          } else {
            doc[key] = value
          }
        }

        tx.createOrReplace(doc as { _id: string; _type: string; [key: string]: unknown })
        blockRefs.push({ _type: "reference", _ref: blockId, _key: block.id })
      }

      // Page document
      const pageId = `page-${page.slug}`.replace(/[^a-zA-Z0-9._-]/g, "-")
      tx.createOrReplace({
        _id: pageId,
        _type: "page",
        slug: { _type: "slug", current: page.slug },
        title: page.title,
        pageId: page.id,
        blocks: blockRefs,
        ...(page.meta ? { meta: page.meta } : {}),
      })
    }

    // Site config (singleton)
    if (config.name || config.logo || config.navLabels) {
      tx.createOrReplace({
        _id: "siteConfig",
        _type: "siteConfig",
        name: config.name ?? "",
        logo: config.logo ?? "",
        navLabels: config.navLabels ?? {},
      })
    }

    try {
      await tx.commit()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Sanity transaction failed" }
    }
  }
}
