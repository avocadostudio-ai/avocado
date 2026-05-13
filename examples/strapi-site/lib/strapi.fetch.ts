import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { lowerToBlockType } from "@avocadostudio-ai/shared"
import { imageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@avocadostudio-ai/shared"

/** Strapi v5 REST response shape */
type StrapiResponse<T> = { data: T; meta?: unknown }
type StrapiItem = {
  id: number
  documentId: string
  [key: string]: unknown
}

/** Resolve a Strapi media field to an absolute URL */
function resolveMediaUrl(field: unknown): string {
  if (!field || typeof field !== "object") return ""
  const media = field as { url?: string; formats?: { large?: { url?: string } } }
  const url = media.formats?.large?.url ?? media.url
  if (!url) return ""
  return url.startsWith("http") ? url : `${STRAPI_URL}${url}`
}

/**
 * Convert a Strapi Dynamic Zone component to a BlockInstance.
 *
 * Dynamic Zone entries have __component: "blocks.hero" and all
 * component fields inline.
 */
function dzComponentToBlock(entry: Record<string, unknown>, index: number): BlockInstance | null {
  const component = entry.__component as string | undefined
  if (!component?.startsWith("blocks.")) return null

  // "blocks.hero" → "Hero", "blocks.featuregrid" → "FeatureGrid", "blocks.cta" → "CTA"
  const rawName = component.replace("blocks.", "")
  const blockType = lowerToBlockType(rawName)

  const imgFields = imageFields.get(blockType) ?? new Set<string>()
  const props: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(entry)) {
    if (key === "id" || key === "__component") continue
    // Strapi returns null for empty fields — skip them so Zod treats them as absent (optional)
    if (value === null || value === undefined) continue
    if (imgFields.has(key)) {
      props[key] = resolveMediaUrl(value)
    } else {
      props[key] = value
    }
  }

  return {
    id: entry.id ? `${entry.id}-${index}` : String(index),
    type: blockType,
    props,
  }
}

/** Convert a Strapi page entry to a PageDoc */
function strapiEntryToPageDoc(entry: StrapiItem): PageDoc | null {
  const slug = entry.slug as string | undefined
  if (!slug) return null

  const rawBlocks = entry.blocks as Array<Record<string, unknown>> | undefined
  const blocks: BlockInstance[] = []
  if (Array.isArray(rawBlocks)) {
    for (let i = 0; i < rawBlocks.length; i++) {
      const block = dzComponentToBlock(rawBlocks[i], i)
      if (block) blocks.push(block)
    }
  }

  return {
    id: (entry.pageId as string) ?? entry.documentId ?? String(entry.id),
    slug,
    title: (entry.title as string) ?? "",
    blocks,
    meta: (entry.pageMeta as PageDoc["meta"]) ?? undefined,
    updatedAt: (entry.updatedAt as string) ?? new Date().toISOString(),
  }
}

export async function getStrapiPage(slug: string): Promise<PageDoc | null> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      `/pages?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[blocks][populate]=*`
    )
    if (!res.data || res.data.length === 0) return null
    return strapiEntryToPageDoc(res.data[0])
  } catch (err) {
    console.error("getStrapiPage failed:", err instanceof Error ? err.message : err)
    return null
  }
}

export async function getStrapiSlugs(): Promise<string[]> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>("/pages?fields[0]=slug&pagination[pageSize]=100")
    return res.data.map((item) => item.slug as string).filter(Boolean)
  } catch (err) {
    console.error("getStrapiSlugs failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getStrapiPages(): Promise<PageDoc[]> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      "/pages?populate[blocks][populate]=*&pagination[pageSize]=100"
    )
    return res.data.map(strapiEntryToPageDoc).filter((p): p is PageDoc => p !== null)
  } catch (err) {
    console.error("getStrapiPages failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getStrapiSiteConfig(): Promise<SiteConfig> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem>>("/site-config?populate=*")
    if (!res.data) return {}
    const rawConstraints = res.data.constraints
    return {
      name: (res.data.name as string) || undefined,
      logo: (res.data.logo as string) || undefined,
      purpose: (res.data.purpose as string) || undefined,
      tone: (res.data.tone as string) || undefined,
      constraints: Array.isArray(rawConstraints) ? (rawConstraints as string[]) : undefined,
      navLabels: (res.data.navLabels as Record<string, string>) || undefined,
      navGroups: (res.data.navGroups as Record<string, string[]>) || undefined,
      themeOverrides: (res.data.themeOverrides as Record<string, string>) || undefined,
    }
  } catch {
    return {}
  }
}
