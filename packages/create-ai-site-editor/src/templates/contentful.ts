import type { GeneratedFile, ScaffoldConfig } from "../types.js"

export function contentfulTemplates(_config: ScaffoldConfig): GeneratedFile[] {
  return [
    { path: "lib/contentful.ts", content: CONTENTFUL_ADAPTER },
    { path: "lib/publish.ts", content: CONTENTFUL_PUBLISH },
  ]
}

const CONTENTFUL_ADAPTER = `import { createClient, type Entry, type Asset } from "contentful"
import { imageFields, listImageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@ai-site-editor/shared"

let cachedClient: ReturnType<typeof createClient> | null = null

function getClient() {
  if (cachedClient) return cachedClient
  const spaceId = process.env.CONTENTFUL_SPACE_ID
  const accessToken = process.env.CONTENTFUL_DELIVERY_TOKEN
  if (!spaceId || !accessToken) throw new Error("CONTENTFUL_SPACE_ID and CONTENTFUL_DELIVERY_TOKEN required")
  cachedClient = createClient({
    space: spaceId, accessToken,
    environment: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  })
  return cachedClient
}

function assetToUrl(asset: Asset | undefined): string {
  if (!asset?.fields?.file) return ""
  const file = asset.fields.file as { url?: string }
  if (!file.url) return ""
  return file.url.startsWith("//") ? \`https:\${file.url}\` : file.url
}

function entryToBlockInstance(entry: Entry, includes?: { Asset?: Asset[] }): BlockInstance | null {
  const contentTypeId = entry.sys.contentType?.sys?.id
  if (!contentTypeId?.startsWith("block")) return null
  const blockType = contentTypeId.replace(/^block/, "")
  const imgFields = imageFields.get(blockType) ?? new Set<string>()
  const listImgFieldsForType = listImageFields.get(blockType)
  const props: Record<string, unknown> = {}
  const fields = entry.fields as Record<string, unknown>

  for (const [key, value] of Object.entries(fields)) {
    if (imgFields.has(key)) {
      const linked = value as { sys?: { id?: string } } | undefined
      if (linked?.sys?.id && includes?.Asset) {
        const asset = includes.Asset.find((a) => a.sys.id === linked.sys.id)
        props[key] = assetToUrl(asset as Asset)
      } else if (linked && typeof linked === "object" && "fields" in linked) {
        props[key] = assetToUrl(linked as Asset)
      } else { props[key] = "" }
    } else if (listImgFieldsForType?.has(key) && blockType === "CardGrid" && key === "cards") {
      const refs = value as Array<Entry | { sys: { id: string } }>
      if (Array.isArray(refs)) {
        props[key] = refs.map((ref) => {
          if ("fields" in ref) {
            const cardInstance = entryToBlockInstance(ref as Entry, includes)
            return cardInstance?.props
          }
          return null
        }).filter(Boolean)
      } else { props[key] = [] }
    } else { props[key] = value }
  }
  return { id: entry.sys.id.replace(/^block_/, ""), type: blockType, props }
}

function entryToPageDoc(page: Entry, includes?: { Asset?: Asset[] }): PageDoc | null {
  const fields = page.fields as Record<string, unknown>
  const slug = fields.slug as string | undefined
  if (!slug) return null
  const blockRefs = fields.blocks as Array<Entry | { sys: { id: string } }> | undefined
  const blocks: BlockInstance[] = []
  if (Array.isArray(blockRefs)) {
    for (const ref of blockRefs) {
      if ("fields" in ref) {
        const block = entryToBlockInstance(ref as Entry, includes)
        if (block) blocks.push(block)
      }
    }
  }
  return {
    id: (fields.pageId as string) ?? page.sys.id,
    slug, title: fields.title as string, blocks,
    meta: fields.meta as PageDoc["meta"],
    updatedAt: (fields.updatedAt as string) ?? page.sys.updatedAt,
  }
}

export async function getContentfulPage(slug: string): Promise<PageDoc | null> {
  const entries = await getClient().getEntries({ content_type: "page", "fields.slug": slug, include: 2, limit: 1 })
  if (entries.items.length === 0) return null
  return entryToPageDoc(entries.items[0], entries.includes as { Asset?: Asset[] })
}

export async function getContentfulSlugs(): Promise<string[]> {
  const entries = await getClient().getEntries({ content_type: "page", select: ["fields.slug"], limit: 100 })
  return entries.items
    .map((item) => (item.fields as Record<string, unknown>).slug)
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
}

export async function getContentfulPages(): Promise<PageDoc[]> {
  const entries = await getClient().getEntries({ content_type: "page", include: 2, limit: 100 })
  return entries.items
    .map((page) => entryToPageDoc(page, entries.includes as { Asset?: Asset[] }))
    .filter((p): p is PageDoc => p !== null)
}

export async function getContentfulSiteConfig(): Promise<SiteConfig> {
  try {
    const entries = await getClient().getEntries({ content_type: "siteConfig", "fields.configKey": "default", limit: 1 })
    if (entries.items.length === 0) return {}
    const fields = entries.items[0].fields as Record<string, unknown>
    return {
      name: (fields.name as string) || undefined,
      logo: (fields.logo as string) || undefined,
      navLabels: (fields.navLabels as Record<string, string>) || undefined,
    }
  } catch { return {} }
}
`

const CONTENTFUL_PUBLISH = `// Contentful publish handler — see examples/contentful-site/lib/publish.ts
// for the full implementation with asset upload, reference lists, and upsert logic.
//
// This is a stub. Copy the full implementation from the example site.

import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"

export interface ContentfulPublishOptions {
  spaceId: string
  environmentId?: string
  managementToken: string
  locale?: string
}

export function createContentfulPublishHandler(_opts: ContentfulPublishOptions): OnPublishFn {
  return async (_pages, _config, _context) => {
    // TODO: Implement Contentful publish handler.
    // See examples/contentful-site/lib/publish.ts for the full implementation.
    return { ok: false, error: "Contentful publish handler not yet implemented. See examples/contentful-site/lib/publish.ts" }
  }
}
`
