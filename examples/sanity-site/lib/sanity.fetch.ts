import { client } from "./sanity.client"
import { pageBySlugQuery, allSlugsQuery, allPagesQuery, siteConfigQuery } from "./sanity.queries"
import { sanityImageUrl } from "./sanity.image"
import { sanityNameToBlockType } from "./sanity.utils"
import { imageFields, listImageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@avocadostudio-ai/shared"

/** Convert a Sanity block document to a BlockInstance */
function sanityDocToBlock(doc: Record<string, unknown>): BlockInstance | null {
  const type = doc._type as string | undefined
  if (!type) return null

  // Convert Sanity name back to PascalCase: cta → CTA, faqAccordion → FAQAccordion
  const blockType = sanityNameToBlockType(type)
  const imgFields = imageFields.get(blockType) ?? new Set<string>()
  const listImgFields = listImageFields.get(blockType) ?? new Map<string, Set<string>>()

  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith("_")) continue // skip Sanity internal fields (_id, _type, _rev, etc.)
    if (value === null || value === undefined) continue // skip nulls (Sanity returns null for absent fields)
    if (imgFields.has(key)) {
      props[key] = sanityImageUrl(value)
    } else if (listImgFields.has(key) && Array.isArray(value)) {
      // Resolve image refs within list items (Gallery.items, Carousel.items, Testimonials.items, etc.)
      const itemImageKeys = listImgFields.get(key)!
      props[key] = value.map((item: Record<string, unknown>) => {
        const resolved: Record<string, unknown> = {}
        for (const [ik, iv] of Object.entries(item)) {
          if (ik.startsWith("_")) continue // strip _key, _type from Sanity
          if (itemImageKeys.has(ik)) {
            resolved[ik] = sanityImageUrl(iv)
          } else {
            resolved[ik] = iv
          }
        }
        return resolved
      })
    } else {
      props[key] = value
    }
  }

  return {
    id: ((doc._id as string) ?? "").replace(/^block-/, ""),
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
    meta: (doc.meta ?? undefined) as PageDoc["meta"],
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

  // Sanity stores records-of-strings as arrays of key/value objects so Studio can edit them.
  // Transform back to Record<string, X> at the read boundary.
  const rawLabels = doc.navLabels as Array<{ slug?: string; label?: string }> | undefined
  const navLabels = Array.isArray(rawLabels) && rawLabels.length > 0
    ? Object.fromEntries(rawLabels.filter((l) => l.slug && l.label).map((l) => [l.slug!, l.label!]))
    : undefined

  const rawGroups = doc.navGroups as Array<{ label?: string; slugs?: string[] }> | undefined
  const navGroups = Array.isArray(rawGroups) && rawGroups.length > 0
    ? Object.fromEntries(
        rawGroups
          .filter((g) => g.label && Array.isArray(g.slugs) && g.slugs.length > 0)
          .map((g) => [g.label!, g.slugs!]),
      )
    : undefined

  const rawTheme = doc.themeOverrides as Array<{ key?: string; value?: string }> | undefined
  const themeOverrides = Array.isArray(rawTheme) && rawTheme.length > 0
    ? Object.fromEntries(rawTheme.filter((t) => t.key && t.value).map((t) => [t.key!, t.value!]))
    : undefined

  const rawConstraints = doc.constraints
  const constraints = Array.isArray(rawConstraints) && rawConstraints.length > 0
    ? (rawConstraints as string[]).filter((c) => typeof c === "string")
    : undefined

  return {
    name: (doc.name as string) || undefined,
    logo: (doc.logo as string) || undefined,
    purpose: (doc.purpose as string) || undefined,
    tone: (doc.tone as string) || undefined,
    constraints,
    navLabels,
    navGroups,
    themeOverrides,
  }
}
