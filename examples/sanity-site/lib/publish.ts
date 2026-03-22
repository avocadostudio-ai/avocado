import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { getAllBlockMeta } from "@ai-site-editor/shared"
import { writeClient } from "./sanity.client"

/** Fields that should be uploaded as Sanity image assets */
function getImageFields(blockType: string): Set<string> {
  const meta = getAllBlockMeta()[blockType]
  if (!meta) return new Set()
  const result = new Set<string>()
  for (const [key, fm] of Object.entries(meta.fields)) {
    if (fm.kind === "image") result.add(key)
  }
  return result
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
        // Convert PascalCase to Sanity name: CTA → cta, FAQAccordion → faqAccordion
        const blockType = block.type === block.type.toUpperCase()
          ? block.type.toLowerCase()
          : (() => { const m = block.type.match(/^([A-Z]+)([A-Z][a-z].*)$/); return m ? m[1].toLowerCase() + m[2] : block.type.charAt(0).toLowerCase() + block.type.slice(1) })()
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

        tx.createOrReplace(doc)
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
        meta: page.meta ?? null,
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
