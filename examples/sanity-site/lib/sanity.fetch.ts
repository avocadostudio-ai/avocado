import { client } from "./sanity.client"
import { pageBySlugQuery, allSlugsQuery, allPagesQuery, siteConfigQuery } from "./sanity.queries"
import { sanityImageUrl } from "./sanity.image"
import { sanityNameToBlockType, getImageFields } from "./sanity.utils"
import type { PageDoc, SiteConfig, BlockInstance } from "@ai-site-editor/shared"

/** Convert a Sanity block document to a BlockInstance */
function sanityDocToBlock(doc: Record<string, unknown>): BlockInstance | null {
  const type = doc._type as string | undefined
  if (!type) return null

  // Convert Sanity name back to PascalCase: cta → CTA, faqAccordion → FAQAccordion
  const blockType = sanityNameToBlockType(type)
  const imageFields = getImageFields(blockType)

  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("_")) continue // skip Sanity internal fields (_id, _type, _rev, etc.)
    if (imageFields.has(key)) {
      props[key] = sanityImageUrl(value)
    } else {
      props[key] = value
    }
  }

  return {
    id: (doc._id as string) ?? "",
    type: blockType,
    props,
  }
}

/** Convert a Sanity page document to a PageDoc */
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
    slug,
    title: (doc.title as string) ?? "",
    blocks,
    meta: doc.meta as PageDoc["meta"],
    updatedAt: (doc._updatedAt as string) ?? new Date().toISOString(),
  }
}

export async function getSanityPage(slug: string): Promise<PageDoc | null> {
  const doc = await client.fetch<Record<string, unknown> | null>(pageBySlugQuery, { slug })
  if (!doc) return null
  return sanityDocToPageDoc(doc)
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
  // Transform navLabels from Sanity array [{slug, label}] to Record<string, string>
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
