import { createClient, type Asset, type Entry } from "contentful"
import type { BlockInstance, PageDoc, SiteConfig } from "@avocadostudio-ai/shared"
import { documentToPlainText } from "./rich-text"

const LOCALE = "en-US"

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

function assetToUrl(asset: Asset | undefined): string {
  if (!asset?.fields?.file) return ""
  const file = asset.fields.file as { url?: string }
  if (!file.url) return ""
  return file.url.startsWith("//") ? `https:${file.url}` : file.url
}

// Resolve an asset link to a URL using the response includes array.
function resolveAssetLink(value: unknown, includes: { Asset?: Asset[] } | undefined): string {
  if (!value || typeof value !== "object") return ""
  const link = value as { sys?: { id?: string }; fields?: unknown }
  if ("fields" in link && link.fields) {
    // Already-resolved inline asset
    return assetToUrl(link as Asset)
  }
  const id = link.sys?.id
  if (!id || !includes?.Asset) return ""
  const match = includes.Asset.find((a) => a.sys.id === id)
  return assetToUrl(match)
}

// Resolve an entry link to the actual entry object, using either inline
// resolved shape or the includes array.
function resolveEntryLink(
  value: unknown,
  includes: { Entry?: Entry[] } | undefined,
): Entry | null {
  if (!value || typeof value !== "object") return null
  const link = value as { sys?: { id?: string; linkType?: string }; fields?: unknown }
  if ("fields" in link && link.fields) return link as unknown as Entry
  const id = link.sys?.id
  if (!id || !includes?.Entry) return null
  return (includes.Entry.find((e) => e.sys.id === id) as Entry | undefined) ?? null
}

// Derive a target-page href from a linked `page` entry (template's
// componentCta.targetPage convention). Falls back to "/" on unresolved links.
function resolveTargetPageHref(
  value: unknown,
  includes: { Entry?: Entry[] } | undefined,
): string {
  const entry = resolveEntryLink(value, includes)
  if (!entry) return "/"
  const fields = entry.fields as Record<string, unknown>
  const slug = (fields.slug as string) ?? ""
  if (!slug || slug === "home") return "/"
  return `/${slug}`
}

type Includes = { Asset?: Asset[]; Entry?: Entry[] }

// ---------------------------------------------------------------------------
// Per-content-type converters: Contentful entry → BlockInstance
// ---------------------------------------------------------------------------

function entryToBlockInstance(entry: Entry, includes: Includes | undefined): BlockInstance | null {
  const typeId = entry.sys.contentType?.sys?.id
  const fields = entry.fields as Record<string, unknown>
  const id = entry.sys.id

  switch (typeId) {
    case "componentHeroBanner":
      return {
        id,
        type: "CtfHeroBanner",
        props: {
          headline: fields.headline ?? "",
          bodyText: documentToPlainText(fields.bodyText),
          ctaText: fields.ctaText ?? "",
          targetPage: resolveTargetPageHref(fields.targetPage, includes),
          imageUrl: resolveAssetLink(fields.image, includes),
          colorPalette: fields.colorPalette ?? "",
          heroSize: fields.heroSize === false ? "fixed_height" : "full_screen",
          imageStyle: fields.imageStyle === true ? "partial" : "full",
        },
      }

    case "componentDuplex":
      return {
        id,
        type: "CtfDuplex",
        props: {
          headline: fields.headline ?? "",
          bodyText: documentToPlainText(fields.bodyText),
          ctaText: fields.ctaText ?? "",
          targetPage: resolveTargetPageHref(fields.targetPage, includes),
          imageUrl: resolveAssetLink(fields.image, includes),
          containerLayout: fields.containerLayout === true ? "image_right" : "image_left",
          colorPalette: fields.colorPalette ?? "",
        },
      }

    case "componentInfoBlock":
      return {
        id,
        type: "CtfInfoBlock",
        props: {
          headline: fields.headline ?? "",
          subline: fields.subline ?? "",
          body: documentToPlainText(fields.body),
          icon: fields.icon ?? "markdown",
          colorPalette: fields.colorPalette ?? "",
        },
      }

    case "componentCta":
      return {
        id,
        type: "CtfCta",
        props: {
          headline: fields.headline ?? "",
          subline: fields.subline ?? "",
          ctaText: fields.ctaText ?? "",
          targetPage: resolveTargetPageHref(fields.targetPage, includes),
          imageUrl: resolveAssetLink(fields.image, includes),
          colorPalette: fields.colorPalette ?? "",
        },
      }

    case "componentQuote":
      return {
        id,
        type: "CtfQuote",
        props: {
          quote: documentToPlainText(fields.quote),
          imageUrl: resolveAssetLink(fields.image, includes),
          imageAlignment: fields.imageAlignment === true ? "right" : "left",
          colorPalette: fields.colorPalette ?? "",
        },
      }

    case "componentTextBlock":
      return {
        id,
        type: "CtfTextBlock",
        props: {
          headline: fields.headline ?? "",
          subline: fields.subline ?? "",
          body: documentToPlainText(fields.body),
        },
      }

    case "topicPerson":
      return {
        id,
        type: "CtfPerson",
        props: {
          name: fields.name ?? "",
          avatarUrl: resolveAssetLink(fields.avatar, includes),
          cardStyle: fields.cardStyle === true ? "compact" : "default",
          shortBio: documentToPlainText(fields.shortBio),
        },
      }

    case "topicProduct": {
      const featureRefs = Array.isArray(fields.features) ? (fields.features as unknown[]) : []
      const features = featureRefs
        .map((ref) => resolveEntryLink(ref, includes))
        .filter((e): e is Entry => e !== null)
        .map((e) => {
          const f = e.fields as Record<string, unknown>
          return {
            name: (f.name as string) ?? "",
            longDescription: documentToPlainText(f.longDescription),
          }
        })
      return {
        id,
        type: "CtfProduct",
        props: {
          name: fields.name ?? "",
          description: documentToPlainText(fields.description),
          imageUrl: resolveAssetLink(fields.featuredImage, includes),
          pricing: fields.pricing ?? "",
          features,
        },
      }
    }

    case "topicBusinessInfo":
      return {
        id,
        type: "CtfBusinessInfo",
        props: {
          name: fields.name ?? "",
          shortDescription: fields.shortDescription ?? "",
          longDescription: documentToPlainText(fields.longDescription),
          imageUrl: resolveAssetLink(fields.featuredImage, includes),
        },
      }

    case "componentProductTable": {
      const productRefs = Array.isArray(fields.productsCollection)
        ? (fields.productsCollection as unknown[])
        : []
      const products = productRefs
        .map((ref) => resolveEntryLink(ref, includes))
        .filter((e): e is Entry => e !== null)
        .map((e) => {
          const f = e.fields as Record<string, unknown>
          return {
            name: (f.name as string) ?? "",
            description: documentToPlainText(f.description),
            pricing: (f.pricing as string) ?? "",
            imageUrl: resolveAssetLink(f.featuredImage, includes),
          }
        })
      return {
        id,
        type: "CtfProductTable",
        props: {
          headline: fields.headline ?? "",
          subline: fields.subline ?? "",
          products,
        },
      }
    }

    case "componentFooter": {
      const menuRefs = Array.isArray(fields.menuItems) ? (fields.menuItems as unknown[]) : []
      const menuItems = menuRefs
        .map((ref) => resolveEntryLink(ref, includes))
        .filter((e): e is Entry => e !== null)
        .map((e) => {
          const f = e.fields as Record<string, unknown>
          const slug = (f.slug as string) ?? ""
          return {
            label: (f.pageName as string) ?? (f.title as string) ?? slug,
            href: !slug || slug === "home" ? "/" : `/${slug}`,
          }
        })
      return {
        id,
        type: "CtfFooter",
        props: {
          copyright: fields.copyright ?? `© ${new Date().getFullYear()}`,
          menuItems,
        },
      }
    }

    default:
      return null
  }
}

// Walks a page entry's topSection + content[] + featuredBlocksCollection
// into a single flat ordered BlockInstance[].
function flattenPageTopics(page: Entry, includes: Includes | undefined): BlockInstance[] {
  const fields = page.fields as Record<string, unknown>
  const blocks: BlockInstance[] = []

  // topSection — typically a single HeroBanner link
  const top = resolveEntryLink(fields.topSection, includes)
  if (top) {
    const b = entryToBlockInstance(top, includes)
    if (b) blocks.push(b)
  }

  // content — array of polymorphic entry links
  const content = Array.isArray(fields.content) ? (fields.content as unknown[]) : []
  for (const ref of content) {
    const entry = resolveEntryLink(ref, includes)
    if (entry) {
      const b = entryToBlockInstance(entry, includes)
      if (b) blocks.push(b)
    }
  }

  // featuredBlocksCollection — trailing list (rarely used but honored)
  const featured = Array.isArray(fields.featuredBlocksCollection)
    ? (fields.featuredBlocksCollection as unknown[])
    : []
  for (const ref of featured) {
    const entry = resolveEntryLink(ref, includes)
    if (entry) {
      const b = entryToBlockInstance(entry, includes)
      if (b) blocks.push(b)
    }
  }

  return blocks
}

function entryToPageDoc(page: Entry, includes: Includes | undefined): PageDoc | null {
  const fields = page.fields as Record<string, unknown>
  const slug = (fields.slug as string | undefined) ?? undefined
  if (!slug) return null

  const blocks = flattenPageTopics(page, includes)
  const seo = fields.seo as { "fields"?: Record<string, unknown> } | undefined
  const seoFields = (seo && "fields" in seo ? seo.fields : undefined) as Record<string, unknown> | undefined

  return {
    id: page.sys.id,
    slug: slug === "home" ? "/" : slug,
    title: (fields.pageName as string) ?? (fields.title as string) ?? slug,
    blocks,
    meta: seoFields
      ? {
          title: seoFields.title as string | undefined,
          description: seoFields.description as string | undefined,
          ogImage: resolveAssetLink(seoFields.ogImage, includes) || undefined,
        }
      : undefined,
    updatedAt: page.sys.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Public API consumed by createSitePage and createEditorApiHandler
// ---------------------------------------------------------------------------

export async function getContentfulPage(slug: string): Promise<PageDoc | null> {
  const client = getClient()
  const normalized = slug === "/" || slug === "" ? "home" : slug
  const entries = await client.getEntries({
    content_type: "page",
    "fields.slug": normalized,
    include: 4,
    limit: 1,
    locale: LOCALE,
  })
  if (entries.items.length === 0) return null
  const includes = entries.includes as Includes | undefined
  return entryToPageDoc(entries.items[0], includes)
}

export async function getContentfulSlugs(): Promise<string[]> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    select: ["fields.slug"],
    limit: 100,
    locale: LOCALE,
  })
  return entries.items
    .map((item) => (item.fields as Record<string, unknown>).slug)
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0)
    .map((slug) => (slug === "home" ? "/" : slug))
}

export async function getContentfulPages(): Promise<PageDoc[]> {
  const client = getClient()
  const entries = await client.getEntries({
    content_type: "page",
    include: 4,
    limit: 100,
    locale: LOCALE,
  })
  const includes = entries.includes as Includes | undefined
  return entries.items
    .map((page) => entryToPageDoc(page, includes))
    .filter((p): p is PageDoc => p !== null)
}

export async function getContentfulSiteConfig(): Promise<SiteConfig> {
  // Template has no first-class site-config content type.
  // Synthesize from a `componentFooter` entry if one exists; otherwise
  // return a sensible default so the editor has something to show.
  try {
    const client = getClient()
    const entries = await client.getEntries({
      content_type: "componentFooter",
      limit: 1,
      locale: LOCALE,
    })
    if (entries.items.length === 0) return { name: "Marketing Site" }
    const fields = entries.items[0].fields as Record<string, unknown>
    return {
      name: (fields.siteName as string) ?? "Marketing Site",
    }
  } catch {
    return { name: "Marketing Site" }
  }
}
