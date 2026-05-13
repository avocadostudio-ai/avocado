import type { GeneratedFile, ScaffoldConfig } from "../types.js"

export function contentfulTemplates(_config: ScaffoldConfig): GeneratedFile[] {
  return [
    { path: "lib/contentful.ts", content: CONTENTFUL_ADAPTER },
    { path: "lib/publish.ts", content: CONTENTFUL_PUBLISH },
  ]
}

const CONTENTFUL_ADAPTER = `import { createClient, type Entry, type Asset } from "contentful"
import { imageFields, listImageFields } from "./manifest"
import type { PageDoc, SiteConfig, BlockInstance } from "@avocadostudio-ai/shared"

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

const CONTENTFUL_PUBLISH = `import type { OnPublishFn, InlineAsset } from "@ai-site-editor/site-sdk/routes"
import { isSafeImageUrl } from "@ai-site-editor/site-sdk/routes"
import { imageFields, listFieldNames } from "./manifest"

export interface ContentfulPublishOptions {
  spaceId: string
  environmentId?: string
  managementToken: string
  locale?: string
}

export function createContentfulPublishHandler(opts: ContentfulPublishOptions): OnPublishFn {
  const locale = opts.locale ?? "en-US"

  let cachedEnvPromise: ReturnType<typeof loadEnvironment> | null = null

  async function loadEnvironment() {
    const mod = await import("contentful-management")
    const factory = ("default" in mod && typeof (mod.default as Record<string, unknown>)?.createClient === "function")
      ? (mod.default as { createClient: typeof mod.createClient }).createClient
      : mod.createClient
    const client = factory({ accessToken: opts.managementToken })
    const space = await client.getSpace(opts.spaceId)
    return space.getEnvironment(opts.environmentId ?? "master")
  }

  function getEnvironment() {
    if (!cachedEnvPromise) {
      cachedEnvPromise = loadEnvironment().catch((err) => { cachedEnvPromise = null; throw err })
    }
    return cachedEnvPromise
  }

  function isReferenceList(blockType: string, listKey: string): string | null {
    if (blockType === "CardGrid" && listKey === "cards") return "blockCard"
    return null
  }

  type CfEnv = Awaited<ReturnType<typeof loadEnvironment>>
  type CfEntry = Awaited<ReturnType<CfEnv["getEntries"]>>["items"][0]

  async function ensureAsset(
    env: CfEnv, imageUrl: string, alt: string, assets?: Record<string, InlineAsset>
  ): Promise<string | null> {
    const inlineAsset = assets?.[imageUrl]
    if (inlineAsset) {
      try {
        const bytes = Buffer.from(inlineAsset.data, "base64")
        const upload = await env.createUpload({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
        const asset = await env.createAsset({
          fields: {
            title: { [locale]: alt || inlineAsset.fileName },
            description: { [locale]: imageUrl },
            file: { [locale]: { contentType: inlineAsset.mimeType, fileName: inlineAsset.fileName, uploadFrom: { sys: { type: "Link", linkType: "Upload", id: upload.sys.id } } } },
          },
        })
        const processed = await asset.processForAllLocales()
        const published = await processed.publish()
        return published.sys.id
      } catch (err) {
        console.warn(\`[contentful-publish] inline asset upload failed for \${imageUrl}: \${err instanceof Error ? err.message : err}\`)
        return null
      }
    }

    if (!imageUrl.startsWith("http") || !isSafeImageUrl(imageUrl)) {
      try {
        const asset = await env.createAsset({
          fields: {
            title: { [locale]: alt || imageUrl },
            description: { [locale]: imageUrl },
            file: { [locale]: { contentType: "image/png", fileName: imageUrl.split("/").pop() || "image.png", upload: \`https://placehold.co/800x600/e4e4e7/52525b?text=\${encodeURIComponent(alt || "Image")}\` } },
          },
        })
        const processed = await asset.processForAllLocales()
        const published = await processed.publish()
        return published.sys.id
      } catch { return null }
    }

    try {
      const existing = await env.getAssets({ "fields.description": imageUrl, limit: 1 })
      if (existing.items.length > 0) return existing.items[0].sys.id
    } catch { /* continue */ }

    try {
      const ext = imageUrl.toLowerCase().split(".").pop()?.split("?")[0] ?? ""
      const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "image/jpeg"
      const asset = await env.createAsset({
        fields: {
          title: { [locale]: alt || imageUrl },
          description: { [locale]: imageUrl },
          file: { [locale]: { contentType: ct, fileName: imageUrl.split("/").pop()?.split("?")[0] || "image.jpg", upload: imageUrl } },
        },
      })
      const processed = await asset.processForAllLocales()
      const published = await processed.publish()
      return published.sys.id
    } catch (err) {
      console.warn(\`[contentful-publish] asset upload failed for \${imageUrl}: \${err instanceof Error ? err.message : err}\`)
      return null
    }
  }

  function assetLink(assetId: string) {
    return { [locale]: { sys: { type: "Link", linkType: "Asset", id: assetId } } }
  }

  function entryLink(entryId: string) {
    return { sys: { type: "Link" as const, linkType: "Entry" as const, id: entryId } }
  }

  function existingAssetId(fieldValue: unknown): string | null {
    if (!fieldValue || typeof fieldValue !== "object") return null
    const localeVal = (fieldValue as Record<string, unknown>)[locale]
    if (!localeVal || typeof localeVal !== "object") return null
    const sys = (localeVal as Record<string, unknown>).sys as { id?: string; linkType?: string } | undefined
    return sys?.linkType === "Asset" && sys.id ? sys.id : null
  }

  async function buildBlockFields(
    env: CfEnv, blockType: string, props: Record<string, unknown>,
    resolveAsset: (url: string, alt: string) => Promise<string | null>,
    existingFields?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const imgFields = imageFields.get(blockType) ?? new Set<string>()
    const listFieldsForType = listFieldNames.get(blockType) ?? new Set<string>()
    const fields: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(props)) {
      if (key === "headingLevel") continue
      if (imgFields.has(key) && typeof value === "string" && value) {
        const altKey = key.replace(/Url$/, "Alt").replace(/^image$/, "imageAlt")
        const alt = typeof props[altKey] === "string" ? (props[altKey] as string) : ""
        const assetId = await resolveAsset(value, alt)
        if (assetId) { fields[key] = assetLink(assetId) }
        else {
          const prevAssetId = existingAssetId(existingFields?.[key])
          if (prevAssetId) fields[key] = assetLink(prevAssetId)
        }
      } else if (listFieldsForType.has(key)) {
        if (!isReferenceList(blockType, key)) { fields[key] = { [locale]: value } }
      } else { fields[key] = { [locale]: value } }
    }
    return fields
  }

  return async (pages, config, context) => {
    const env = await getEnvironment()
    const assetCache = new Map<string, Promise<string | null>>()
    const cachedEnsureAsset = (imageUrl: string, alt: string) => {
      const cached = assetCache.get(imageUrl)
      if (cached) return cached
      const promise = ensureAsset(env, imageUrl, alt, context?.assets)
      assetCache.set(imageUrl, promise)
      return promise
    }

    const upsertResults = await Promise.allSettled(pages.map(async (page) => {
      const blockEntries = await Promise.all(page.blocks.map(async (block) => {
        const contentTypeId = \`block\${block.type}\`
        const rawId = block.id.startsWith("block_") ? block.id : \`block_\${block.id}\`
        const entryId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)

        let existingEntry: CfEntry | null = null
        try { existingEntry = await env.getEntry(entryId) } catch { /* first publish */ }
        const existingFields = existingEntry?.fields as Record<string, unknown> | undefined

        const blockFields = await buildBlockFields(env, block.type, block.props, cachedEnsureAsset, existingFields)

        const blockListFields = listFieldNames.get(block.type) ?? new Set<string>()
        for (const [key, value] of Object.entries(block.props)) {
          const refTarget = isReferenceList(block.type, key)
          if (refTarget && Array.isArray(value) && blockListFields.has(key)) {
            const items = value as Record<string, unknown>[]
            const cardRefs = await Promise.all(
              items.map(async (item, i) => {
                const cardEntryId = \`card_\${entryId}_\${i}\`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
                let existingCard: CfEntry | null = null
                try { existingCard = await env.getEntry(cardEntryId) } catch { /* first publish */ }
                const childFields = await buildBlockFields(env, "Card", item, cachedEnsureAsset,
                  existingCard?.fields as Record<string, unknown> | undefined)
                if (existingCard) {
                  existingCard.fields = childFields
                  const updated = await existingCard.update()
                  await updated.publish()
                } else {
                  const created = await env.createEntryWithId(refTarget, cardEntryId, { fields: childFields })
                  await created.publish()
                }
                return entryLink(cardEntryId)
              })
            )
            blockFields[key] = { [locale]: cardRefs }
            for (let i = items.length; i < items.length + 20; i++) {
              const staleCardId = \`card_\${entryId}_\${i}\`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
              try {
                const staleCard = await env.getEntry(staleCardId)
                try { await staleCard.unpublish() } catch {}
                await staleCard.delete()
              } catch { break }
            }
          }
        }

        if (existingEntry) {
          existingEntry.fields = blockFields
          const updated = await existingEntry.update()
          await updated.publish()
          return entryLink(updated.sys.id)
        } else {
          const entry = await env.createEntryWithId(contentTypeId, entryId, { fields: blockFields })
          await entry.publish()
          return entryLink(entry.sys.id)
        }
      }))

      const pageFields = {
        slug: { [locale]: page.slug }, title: { [locale]: page.title },
        pageId: { [locale]: page.id }, blocks: { [locale]: blockEntries },
        meta: { [locale]: page.meta ?? null }, updatedAt: { [locale]: page.updatedAt },
      }
      const existingPages = await env.getEntries({ content_type: "page", "fields.slug": page.slug, limit: 1 })
      if (existingPages.items.length > 0) {
        const existing = existingPages.items[0]
        existing.fields = pageFields
        const updated = await existing.update()
        await updated.publish()
      } else {
        const created = await env.createEntry("page", { fields: pageFields })
        await created.publish()
      }
      return page.slug
    }))

    const failed = upsertResults
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r, i) => \`\${pages[i]?.slug ?? "?"}: \${r.reason instanceof Error ? r.reason.message : String(r.reason)}\`)

    if (config.name || config.logo || config.navLabels) {
      const configFields = {
        configKey: { [locale]: "default" }, name: { [locale]: config.name ?? "" },
        logo: { [locale]: config.logo ?? "" }, navLabels: { [locale]: config.navLabels ?? {} },
      }
      const existingConfig = await env.getEntries({ content_type: "siteConfig", "fields.configKey": "default", limit: 1 })
      let configEntry
      if (existingConfig.items.length > 0) {
        configEntry = existingConfig.items[0]
        configEntry.fields = configFields
        configEntry = await configEntry.update()
      } else { configEntry = await env.createEntry("siteConfig", { fields: configFields }) }
      await configEntry.publish()
    }

    if (failed.length > 0) return { ok: false, error: \`Failed to publish: \${failed.join("; ")}\` }
    return { ok: true }
  }
}
`
