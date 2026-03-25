import type { GeneratedFile, ScaffoldConfig } from "../types.js"

export function sanityTemplates(_config: ScaffoldConfig): GeneratedFile[] {
  return [
    { path: "lib/sanity.client.ts", content: SANITY_CLIENT },
    { path: "lib/sanity.queries.ts", content: SANITY_QUERIES },
    { path: "lib/sanity.image.ts", content: SANITY_IMAGE },
    { path: "lib/sanity.utils.ts", content: SANITY_UTILS },
    { path: "lib/sanity.fetch.ts", content: SANITY_FETCH },
    { path: "lib/publish.ts", content: SANITY_PUBLISH },
  ]
}

const SANITY_CLIENT = `import { createClient } from "@sanity/client"

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
if (!projectId) throw new Error("NEXT_PUBLIC_SANITY_PROJECT_ID is required")
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET ?? "production"
const apiVersion = "2024-01-01"

export const client = createClient({
  projectId, dataset, apiVersion,
  useCdn: process.env.NODE_ENV === "production",
})

export const writeClient = createClient({
  projectId, dataset, apiVersion,
  useCdn: false,
  token: process.env.SANITY_API_TOKEN,
})
`

const SANITY_QUERIES = `import groq from "groq"

export const pageBySlugQuery = groq\`
  *[_type == "page" && slug.current == $slug][0] {
    _id, title, "slug": slug.current, pageId,
    blocks[]-> { _id, _type, ..., "cards": cards[]-> { ... } },
    meta, _updatedAt
  }
\`

export const allSlugsQuery = groq\`
  *[_type == "page"] { "slug": slug.current }
\`

export const allPagesQuery = groq\`
  *[_type == "page"] {
    _id, title, "slug": slug.current, pageId,
    blocks[]-> { _id, _type, ..., "cards": cards[]-> { ... } },
    meta, _updatedAt
  }
\`

export const siteConfigQuery = groq\`
  *[_type == "siteConfig"][0] { name, logo, navLabels }
\`
`

const SANITY_IMAGE = `import imageUrlBuilder from "@sanity/image-url"
import { client } from "./sanity.client"

const builder = imageUrlBuilder(client)

export function sanityImageUrl(source: unknown): string {
  if (!source || typeof source !== "object") return ""
  const ref = source as { _type?: string; asset?: { _ref?: string } }
  if (ref._type !== "image" || !ref.asset?._ref) return ""
  return builder.image(source).auto("format").url()
}
`

const SANITY_UTILS = `export { blockTypeToCamel as toSanityName, camelToBlockType as sanityNameToBlockType } from "@ai-site-editor/shared"

export const REFERENCE_LISTS: Record<string, Set<string>> = {
  CardGrid: new Set(["cards"]),
}
`

const SANITY_FETCH = `import { client } from "./sanity.client"
import { pageBySlugQuery, allSlugsQuery, allPagesQuery, siteConfigQuery } from "./sanity.queries"
import { sanityImageUrl } from "./sanity.image"
import { sanityNameToBlockType } from "./sanity.utils"
import { imageFields, listImageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@ai-site-editor/shared"

function sanityDocToBlock(doc: Record<string, unknown>): BlockInstance | null {
  const type = doc._type as string | undefined
  if (!type) return null
  const blockType = sanityNameToBlockType(type)
  const imgFields = imageFields.get(blockType) ?? new Set<string>()
  const listImgFields = listImageFields.get(blockType) ?? new Map<string, Set<string>>()

  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("_")) continue
    if (value === null || value === undefined) continue
    if (imgFields.has(key)) {
      props[key] = sanityImageUrl(value)
    } else if (listImgFields.has(key) && Array.isArray(value)) {
      const itemImageKeys = listImgFields.get(key)!
      props[key] = value.map((item: Record<string, unknown>) => {
        const resolved: Record<string, unknown> = {}
        for (const [ik, iv] of Object.entries(item)) {
          if (ik.startsWith("_")) continue
          resolved[ik] = itemImageKeys.has(ik) ? sanityImageUrl(iv) : iv
        }
        return resolved
      })
    } else {
      props[key] = value
    }
  }
  return { id: ((doc._id as string) ?? "").replace(/^block-/, ""), type: blockType, props }
}

function sanityDocToPageDoc(doc: Record<string, unknown>): PageDoc | null {
  const slug = doc.slug as string | undefined
  if (!slug) return null
  const rawBlocks = doc.blocks as Record<string, unknown>[] | undefined
  const blocks: BlockInstance[] = []
  if (Array.isArray(rawBlocks)) {
    for (const raw of rawBlocks) {
      const block = sanityDocToBlock(raw)
      if (block) blocks.push(block)
    }
  }
  return {
    id: (doc.pageId as string) ?? (doc._id as string) ?? "",
    slug, title: (doc.title as string) ?? "", blocks,
    meta: (doc.meta ?? undefined) as PageDoc["meta"],
    updatedAt: (doc._updatedAt as string) ?? new Date().toISOString(),
  }
}

export async function getSanityPage(slug: string): Promise<PageDoc | null> {
  const doc = await client.fetch<Record<string, unknown> | null>(pageBySlugQuery, { slug })
  return doc ? sanityDocToPageDoc(doc) : null
}

export async function getSanitySlugs(): Promise<string[]> {
  const docs = await client.fetch<Array<{ slug: string }>>(allSlugsQuery)
  return docs.map((d) => d.slug).filter(Boolean)
}

export async function getSanityPages(): Promise<PageDoc[]> {
  const docs = await client.fetch<Array<Record<string, unknown>>>(allPagesQuery)
  return docs.map(sanityDocToPageDoc).filter((p): p is PageDoc => p !== null)
}

export async function getSanitySiteConfig(): Promise<SiteConfig> {
  const doc = await client.fetch<Record<string, unknown> | null>(siteConfigQuery)
  if (!doc) return {}
  const rawLabels = doc.navLabels as Array<{ slug?: string; label?: string }> | undefined
  const navLabels = Array.isArray(rawLabels) && rawLabels.length > 0
    ? Object.fromEntries(rawLabels.filter((l) => l.slug && l.label).map((l) => [l.slug!, l.label!]))
    : undefined
  return {
    name: (doc.name as string) || undefined,
    logo: (doc.logo as string) || undefined,
    navLabels,
  }
}
`

const SANITY_PUBLISH = `import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { createImageResolver } from "@ai-site-editor/site-sdk/routes"
import { writeClient } from "./sanity.client"
import { toSanityName, REFERENCE_LISTS } from "./sanity.utils"
import { imageFields, listImageFields } from "./manifest"

type SanityImageRef = { _type: "image"; asset: { _type: "reference"; _ref: string } }

async function resolveImageFields(
  item: Record<string, unknown>,
  imageKeys: Set<string>,
  existing: Record<string, unknown> | undefined,
  resolver: { resolve: (url: string) => Promise<SanityImageRef | null> },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) {
    if (imageKeys.has(k) && typeof v === "string" && v) {
      const ref = await resolver.resolve(v)
      out[k] = ref ?? existing?.[k] ?? undefined
    } else {
      out[k] = v
    }
  }
  return out
}

async function fetchExistingDocs(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>()
  if (ids.length === 0) return result
  try {
    const docs = await writeClient.fetch<Array<Record<string, unknown>>>(\`*[_id in $ids]\`, { ids })
    for (const doc of docs) result.set(doc._id as string, doc)
  } catch { /* first publish */ }
  return result
}

export function createSanityPublishHandler(): OnPublishFn {
  return async (pages, config, context) => {
    const imageResolver = createImageResolver<SanityImageRef>(
      async (bytes, fileName, mimeType) => {
        const asset = await writeClient.assets.upload("image", bytes, { filename: fileName, contentType: mimeType })
        return { _type: "image" as const, asset: { _type: "reference" as const, _ref: asset._id } }
      },
      context?.assets,
    )
    const tx = writeClient.transaction()

    for (const page of pages) {
      const docIds: string[] = []
      for (const block of page.blocks) {
        const blockId = \`block-\${block.id}\`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
        docIds.push(blockId)
        const refLists = REFERENCE_LISTS[block.type]
        if (refLists) {
          for (const [key, value] of Object.entries(block.props)) {
            if (refLists.has(key) && Array.isArray(value)) {
              for (let i = 0; i < value.length; i++) {
                docIds.push(\`card-\${blockId}-\${i}\`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128))
              }
            }
          }
        }
      }
      const existingDocs = await fetchExistingDocs(docIds)

      const blockRefs = await Promise.all(page.blocks.map(async (block) => {
        const blockId = \`block-\${block.id}\`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
        const blockType = toSanityName(block.type)
        const imgFields = imageFields.get(block.type) ?? new Set<string>()
        const listImgFields = listImageFields.get(block.type) ?? new Map<string, Set<string>>()
        const refLists = REFERENCE_LISTS[block.type]
        const existingDoc = existingDocs.get(blockId)
        const doc: Record<string, unknown> = { _id: blockId, _type: blockType }

        for (const [key, value] of Object.entries(block.props)) {
          if (key === "headingLevel") continue
          if (imgFields.has(key) && typeof value === "string" && value) {
            const imageRef = await imageResolver.resolve(value)
            doc[key] = imageRef ?? existingDoc?.[key] ?? undefined
          } else if (refLists?.has(key) && Array.isArray(value)) {
            const itemImageKeys = listImgFields.get(key) ?? new Set<string>()
            const cardRefs = await Promise.all(
              (value as Record<string, unknown>[]).map(async (item, idx) => {
                const cardId = \`card-\${blockId}-\${idx}\`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 128)
                const fields = await resolveImageFields(item, itemImageKeys, existingDocs.get(cardId), imageResolver)
                tx.createOrReplace({ _id: cardId, _type: "card", ...fields } as { _id: string; _type: string; [key: string]: unknown })
                return { _type: "reference" as const, _ref: cardId, _key: \`card-\${idx}\` }
              })
            )
            doc[key] = cardRefs
          } else if (listImgFields.has(key) && Array.isArray(value)) {
            const itemImageKeys = listImgFields.get(key)!
            const existingItems = existingDoc?.[key] as Record<string, unknown>[] | undefined
            doc[key] = await Promise.all(
              (value as Record<string, unknown>[]).map(async (item, idx) => ({
                _key: \`item-\${idx}\`,
                ...await resolveImageFields(item, itemImageKeys, existingItems?.[idx], imageResolver),
              }))
            )
          } else {
            doc[key] = value
          }
        }
        tx.createOrReplace(doc as { _id: string; _type: string; [key: string]: unknown })
        return { _type: "reference" as const, _ref: blockId, _key: block.id }
      }))

      const pageId = \`page-\${page.slug}\`.replace(/[^a-zA-Z0-9._-]/g, "-")
      tx.createOrReplace({
        _id: pageId, _type: "page",
        slug: { _type: "slug", current: page.slug },
        title: page.title, pageId: page.id, blocks: blockRefs,
        ...(page.meta ? { meta: page.meta } : {}),
      })
    }

    if (config.name || config.logo || config.navLabels) {
      tx.createOrReplace({
        _id: "siteConfig", _type: "siteConfig",
        name: config.name ?? "", logo: config.logo ?? "", navLabels: config.navLabels ?? {},
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
`
