import type { OnPublishFn, PublishContext, InlineAsset } from "@ai-site-editor/site-sdk/routes"
import { writeClient } from "./sanity.client"
import { toSanityName, getImageFields, getListImageFields, REFERENCE_LISTS } from "./sanity.utils"

/** Reject URLs pointing at private/loopback addresses. */
function isSafeImageUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const h = parsed.hostname
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0") return false
  if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return false
  if (/^172\/(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/** Upload an image URL as a Sanity asset, return the asset reference */
type SanityImageRef = { _type: "image"; asset: { _type: "reference"; _ref: string } }

async function ensureImageAsset(
  imageUrl: string,
  cache: Map<string, Promise<SanityImageRef | null>>,
  assets?: Record<string, InlineAsset>
) {
  const cached = cache.get(imageUrl)
  if (cached) return cached

  const promise = (async () => {
    if (!imageUrl.startsWith("http")) return null

    const inlineAsset = assets?.[imageUrl]
    if (inlineAsset) {
      try {
        const buf = Buffer.from(inlineAsset.data, "base64")
        const asset = await writeClient.assets.upload("image", buf, {
          filename: inlineAsset.fileName,
          contentType: inlineAsset.mimeType,
        })
        return {
          _type: "image" as const,
          asset: { _type: "reference" as const, _ref: asset._id },
        }
      } catch { return null }
    }

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

type ImageProcessCtx = {
  imageCache: Map<string, Promise<SanityImageRef | null>>
  assets?: Record<string, InlineAsset>
}

/** Resolve image fields in a record, falling back to existing values on failure. */
async function resolveImageFields(
  item: Record<string, unknown>,
  imageKeys: Set<string>,
  existing: Record<string, unknown> | undefined,
  ctx: ImageProcessCtx,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (imageKeys.has(k) && typeof v === "string" && v) {
      const ref = await ensureImageAsset(v, ctx.imageCache, ctx.assets)
      out[k] = ref ?? existing?.[k] ?? undefined
    } else {
      out[k] = v
    }
  }
  return out
}

/** Batch-fetch existing Sanity documents by IDs (single GROQ query). */
async function fetchExistingDocs(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>()
  if (ids.length === 0) return result
  try {
    const docs = await writeClient.fetch<Array<Record<string, unknown>>>(
      `*[_id in $ids]`, { ids }
    )
    for (const doc of docs) result.set(doc._id as string, doc)
  } catch { /* first publish — no existing docs */ }
  return result
}

/**
 * Publish handler using Sanity transactions (all-or-nothing).
 *
 * Each block becomes a Sanity document (type = lowercase block type).
 * Pages reference blocks via an array of references.
 * Images are uploaded as Sanity assets — both scalar and within list items.
 */
export function createSanityPublishHandler(): OnPublishFn {
  return async (pages, config, context) => {
    const ctx: ImageProcessCtx = { imageCache: new Map(), assets: context?.assets }
    const tx = writeClient.transaction()

    for (const page of pages) {
      // Collect all document IDs we'll need for fallback, then batch-fetch
      const docIds: string[] = []
      for (const block of page.blocks) {
        const blockId = `block-${block.id}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
        docIds.push(blockId)
        const refLists = REFERENCE_LISTS[block.type]
        if (refLists) {
          for (const [key, value] of Object.entries(block.props)) {
            if (refLists.has(key) && Array.isArray(value)) {
              for (let i = 0; i < value.length; i++) {
                docIds.push(`card-${blockId}-${i}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128))
              }
            }
          }
        }
      }
      const existingDocs = await fetchExistingDocs(docIds)

      const blockRefs = await Promise.all(page.blocks.map(async (block) => {
        const blockId = `block-${block.id}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
        const blockType = toSanityName(block.type)
        const imageFields = getImageFields(block.type)
        const listImageFields = getListImageFields(block.type)
        const refLists = REFERENCE_LISTS[block.type]
        const existingDoc = existingDocs.get(blockId)

        const doc: Record<string, unknown> = { _id: blockId, _type: blockType }

        for (const [key, value] of Object.entries(block.props)) {
          if (key === "headingLevel") continue

          if (imageFields.has(key) && typeof value === "string" && value) {
            const imageRef = await ensureImageAsset(value, ctx.imageCache, ctx.assets)
            doc[key] = imageRef ?? existingDoc?.[key] ?? undefined

          } else if (refLists?.has(key) && Array.isArray(value)) {
            const itemImageKeys = listImageFields.get(key) ?? new Set<string>()
            const cardRefs = await Promise.all(
              (value as Record<string, unknown>[]).map(async (item, idx) => {
                const cardId = `card-${blockId}-${idx}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
                const fields = await resolveImageFields(item, itemImageKeys, existingDocs.get(cardId), ctx)
                tx.createOrReplace({ _id: cardId, _type: "card", ...fields } as { _id: string; _type: string; [key: string]: unknown })
                return { _type: "reference" as const, _ref: cardId, _key: `card-${idx}` }
              })
            )
            doc[key] = cardRefs

          } else if (listImageFields.has(key) && Array.isArray(value)) {
            const itemImageKeys = listImageFields.get(key)!
            const existingItems = existingDoc?.[key] as Record<string, unknown>[] | undefined
            doc[key] = await Promise.all(
              (value as Record<string, unknown>[]).map(async (item, idx) => ({
                _key: `item-${idx}`,
                ...await resolveImageFields(item, itemImageKeys, existingItems?.[idx], ctx),
              }))
            )

          } else {
            doc[key] = value
          }
        }

        tx.createOrReplace(doc as { _id: string; _type: string; [key: string]: unknown })
        return { _type: "reference" as const, _ref: blockId, _key: block.id }
      }))

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
