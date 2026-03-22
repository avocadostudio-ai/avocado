import { strapiFetch, STRAPI_URL } from "./strapi.client"
import { getAllBlockMeta } from "@ai-site-editor/shared"
import type { PageDoc, SiteConfig, BlockInstance } from "@ai-site-editor/shared"

/** Strapi v4/v5 REST response shape */
type StrapiResponse<T> = { data: T; meta?: unknown }
type StrapiItem = {
  id: number
  documentId: string
  [key: string]: unknown
}

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

/** Resolve a Strapi media field to an absolute URL */
function resolveMediaUrl(field: unknown): string {
  if (!field || typeof field !== "object") return ""
  const media = field as { url?: string; formats?: { large?: { url?: string } } }
  const url = media.formats?.large?.url ?? media.url
  if (!url) return ""
  return url.startsWith("http") ? url : `${STRAPI_URL}${url}`
}

/** Convert a Strapi block entry to a BlockInstance */
function strapiEntryToBlock(entry: StrapiItem): BlockInstance | null {
  // Strapi content type API names are plural (e.g., "heroes"), but the
  // __component field in dynamic zones uses singular (e.g., "hero")
  // For relation-based blocks, we use a custom blockType field
  const blockType = (entry.blockType as string) ?? ""
  if (!blockType) return null

  const imageFields = getImageFields(blockType)
  const props: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(entry)) {
    if (key === "id" || key === "documentId" || key === "createdAt" || key === "updatedAt" || key === "publishedAt" || key === "locale" || key === "blockType") continue

    if (imageFields.has(key)) {
      props[key] = resolveMediaUrl(value)
    } else {
      props[key] = value
    }
  }

  return {
    id: entry.documentId ?? String(entry.id),
    type: blockType,
    props,
  }
}

/** Convert a Strapi page entry to a PageDoc */
function strapiEntryToPageDoc(entry: StrapiItem): PageDoc | null {
  const slug = entry.slug as string | undefined
  if (!slug) return null

  const rawBlocks = entry.blocks as StrapiItem[] | undefined
  const blocks: BlockInstance[] = []
  if (Array.isArray(rawBlocks)) {
    for (const raw of rawBlocks) {
      const block = strapiEntryToBlock(raw)
      if (block) blocks.push(block)
    }
  }

  return {
    id: (entry.pageId as string) ?? entry.documentId ?? String(entry.id),
    slug,
    title: (entry.title as string) ?? "",
    blocks,
    meta: entry.pageMeta as PageDoc["meta"],
    updatedAt: (entry.updatedAt as string) ?? new Date().toISOString(),
  }
}

export async function getStrapiPage(slug: string): Promise<PageDoc | null> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      `/pages?filters[slug][$eq]=${encodeURIComponent(slug)}&populate=*`
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
    return res.data
      .map((item) => item.slug as string)
      .filter(Boolean)
  } catch (err) {
    console.error("getStrapiSlugs failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getStrapiPages(): Promise<PageDoc[]> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem[]>>(
      "/pages?populate=*&pagination[pageSize]=100"
    )
    return res.data
      .map(strapiEntryToPageDoc)
      .filter((p): p is PageDoc => p !== null)
  } catch (err) {
    console.error("getStrapiPages failed:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function getStrapiSiteConfig(): Promise<SiteConfig> {
  try {
    const res = await strapiFetch<StrapiResponse<StrapiItem>>("/site-config?populate=*")
    if (!res.data) return {}
    return {
      name: (res.data.name as string) || undefined,
      logo: (res.data.logo as string) || undefined,
      navLabels: (res.data.navLabels as Record<string, string>) || undefined,
    }
  } catch {
    return {}
  }
}
