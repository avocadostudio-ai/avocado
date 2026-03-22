import { createClient } from "contentful"
import { pageDocSchemaLenient } from "@ai-site-editor/shared"
import type { PageDoc, SiteConfig } from "@ai-site-editor/shared"

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

function entryToPageDoc(fields: Record<string, unknown>): PageDoc | null {
  const raw = {
    id: fields.pageId,
    slug: fields.slug,
    title: fields.title,
    blocks: fields.blocks,
    meta: fields.meta,
    updatedAt: fields.updatedAt,
  }
  const parsed = pageDocSchemaLenient.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
}

export async function getContentfulPage(slug: string): Promise<PageDoc | null> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    "fields.slug": slug,
    limit: 1,
  })
  if (entries.items.length === 0) return null
  return entryToPageDoc(entries.items[0].fields as Record<string, unknown>)
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
    limit: 100,
  })
  return entries.items
    .map((item) => entryToPageDoc(item.fields as Record<string, unknown>))
    .filter((page): page is PageDoc => page !== null)
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
    const fields = entries.items[0].fields as unknown as {
      name?: string
      logo?: string
      navLabels?: Record<string, string>
    }
    return {
      name: fields.name || undefined,
      logo: fields.logo || undefined,
      navLabels: fields.navLabels || undefined,
    }
  } catch {
    return {}
  }
}
