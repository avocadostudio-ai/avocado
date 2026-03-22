import { createClient, type Entry, type Asset } from "contentful"
import { getAllBlockMeta, getImageFields } from "@ai-site-editor/shared"
import type { PageDoc, SiteConfig, BlockInstance } from "@ai-site-editor/shared"

let cachedClient: ReturnType<typeof createClient> | null = null

function getClient() {
  if (cachedClient) return cachedClient
  const spaceId = process.env.CONTENTFUL_SPACE_ID
  const accessToken = process.env.CONTENTFUL_DELIVERY_TOKEN
  if (!spaceId || !accessToken) {
    throw new Error("CONTENTFUL_SPACE_ID and CONTENTFUL_DELIVERY_TOKEN are required")
  }
  cachedClient = createClient({
    space: spaceId,
    accessToken,
    environment: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  })
  return cachedClient
}

// Convert a Contentful Asset to a URL string
function assetToUrl(asset: Asset | undefined): string {
  if (!asset?.fields?.file) return ""
  const file = asset.fields.file as { url?: string }
  if (!file.url) return ""
  return file.url.startsWith("//") ? `https:${file.url}` : file.url
}

// Convert a block entry to a BlockInstance, resolving Asset references to URLs
function entryToBlockInstance(entry: Entry, includes?: { Asset?: Asset[] }): BlockInstance | null {
  const contentTypeId = entry.sys.contentType?.sys?.id
  if (!contentTypeId?.startsWith("block")) return null

  const blockType = contentTypeId.replace(/^block/, "")
  const imageFields = getImageFields(blockType)
  const meta = getAllBlockMeta()[blockType]
  const props: Record<string, unknown> = {}

  const fields = entry.fields as Record<string, unknown>

  for (const [key, value] of Object.entries(fields)) {
    if (imageFields.has(key)) {
      // Asset link → resolve to URL
      const linked = value as { sys?: { id?: string } } | undefined
      if (linked?.sys?.id && includes?.Asset) {
        const asset = includes.Asset.find((a) => a.sys.id === linked.sys.id)
        props[key] = assetToUrl(asset as Asset)
      } else if (linked && typeof linked === "object" && "fields" in linked) {
        // Already resolved inline
        props[key] = assetToUrl(linked as Asset)
      } else {
        props[key] = ""
      }
    } else if (meta?.listFields?.[key] && blockType === "CardGrid" && key === "cards") {
      // Reference array → resolve to Card props
      const refs = value as Array<Entry | { sys: { id: string } }>
      if (Array.isArray(refs)) {
        props[key] = refs
          .map((ref) => {
            if ("fields" in ref) {
              // Resolved entry
              const cardInstance = entryToBlockInstance(ref as Entry, includes)
              return cardInstance?.props
            }
            return null
          })
          .filter(Boolean)
      } else {
        props[key] = []
      }
    } else {
      props[key] = value
    }
  }

  return {
    id: entry.sys.id,
    type: blockType,
    props,
  }
}

function entryToPageDoc(
  page: Entry,
  includes?: { Asset?: Asset[] }
): PageDoc | null {
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
    slug,
    title: fields.title as string,
    blocks,
    meta: fields.meta as PageDoc["meta"],
    updatedAt: (fields.updatedAt as string) ?? page.sys.updatedAt,
  }
}

export async function getContentfulPage(slug: string): Promise<PageDoc | null> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    "fields.slug": slug,
    include: 2,
    limit: 1,
  })
  if (entries.items.length === 0) return null
  return entryToPageDoc(entries.items[0], entries.includes as { Asset?: Asset[] })
}

export async function getContentfulSlugs(): Promise<string[]> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    select: ["fields.slug"],
    limit: 100,
  })
  return entries.items
    .map((item) => (item.fields as Record<string, unknown>).slug)
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
}

export async function getContentfulPages(): Promise<PageDoc[]> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    include: 2,
    limit: 100,
  })
  return entries.items
    .map((page) => entryToPageDoc(page, entries.includes as { Asset?: Asset[] }))
    .filter((p): p is PageDoc => p !== null)
}

export async function getContentfulSiteConfig(): Promise<SiteConfig> {
  const client = getClient()
  try {
    const entries = await client.getEntries({
      content_type: "siteConfig",
      "fields.configKey": "default",
      limit: 1,
    })
    if (entries.items.length === 0) return {}
    const fields = entries.items[0].fields as Record<string, unknown>
    return {
      name: (fields.name as string) || undefined,
      logo: (fields.logo as string) || undefined,
      navLabels: (fields.navLabels as Record<string, string>) || undefined,
    }
  } catch {
    return {}
  }
}
