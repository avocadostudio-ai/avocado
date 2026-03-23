import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { getAllBlockMeta, getImageFields } from "@ai-site-editor/shared"

export interface ContentfulPublishOptions {
  spaceId: string
  environmentId?: string
  managementToken: string
  locale?: string
}

/**
 * Publish handler that creates per-block Contentful entries with native fields.
 *
 * Each block becomes its own entry (content type: `block{Type}`).
 * Pages reference blocks via an ordered Array of Links.
 * Image fields are stored as Contentful Asset links.
 * CardGrid.cards are references to blockCard entries.
 */
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
      cachedEnvPromise = loadEnvironment().catch((err) => {
        cachedEnvPromise = null
        throw err
      })
    }
    return cachedEnvPromise
  }

  // Check if a list field should be references (CardGrid.cards → blockCard)
  function isReferenceList(blockType: string, listKey: string): string | null {
    if (blockType === "CardGrid" && listKey === "cards") return "blockCard"
    return null
  }

  type CfEnv = Awaited<ReturnType<typeof loadEnvironment>>
  type CfEntry = Awaited<ReturnType<CfEnv["getEntries"]>>["items"][0]

  /** Reject URLs pointing at private/loopback addresses. */
  function isSafeImageUrl(raw: string): boolean {
    let parsed: URL
    try { parsed = new URL(raw) } catch { return false }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    const h = parsed.hostname
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "0.0.0.0") return false
    if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return false
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
    return true
  }

  // Upload an image URL as a Contentful Asset, return the asset ID
  async function ensureAsset(env: CfEnv, imageUrl: string, alt: string): Promise<string> {
    // Skip non-http URLs (relative paths, data URIs) or private IPs
    if (!imageUrl.startsWith("http") || !isSafeImageUrl(imageUrl)) {
      // Create a placeholder asset with the URL as title
      const asset = await env.createAsset({
        fields: {
          title: { [locale]: alt || imageUrl },
          description: { [locale]: "" },
          file: {
            [locale]: {
              contentType: "image/png",
              fileName: imageUrl.split("/").pop() || "image.png",
              upload: `https://placehold.co/800x600/e4e4e7/52525b?text=${encodeURIComponent(alt || "Image")}`,
            },
          },
        },
      })
      const processed = await asset.processForAllLocales()
      const published = await processed.publish()
      return published.sys.id
    }

    // Check if asset already exists by URL (search by title as a proxy)
    const existing = await env.getAssets({ "fields.title": imageUrl, limit: 1 })
    if (existing.items.length > 0) return existing.items[0].sys.id

    const asset = await env.createAsset({
      fields: {
        title: { [locale]: alt || imageUrl },
        description: { [locale]: "" },
        file: {
          [locale]: {
            contentType: guessContentType(imageUrl),
            fileName: imageUrl.split("/").pop()?.split("?")[0] || "image.jpg",
            upload: imageUrl,
          },
        },
      },
    })
    const processed = await asset.processForAllLocales()
    const published = await processed.publish()
    return published.sys.id
  }

  function guessContentType(url: string): string {
    const lower = url.toLowerCase()
    if (lower.includes(".png")) return "image/png"
    if (lower.includes(".webp")) return "image/webp"
    if (lower.includes(".gif")) return "image/gif"
    if (lower.includes(".svg")) return "image/svg+xml"
    return "image/jpeg"
  }

  // Build Contentful fields for a block entry, converting images to Asset links
  async function buildBlockFields(
    env: CfEnv,
    blockType: string,
    props: Record<string, unknown>,
    resolveAsset: (url: string, alt: string) => Promise<string> = (url, alt) => ensureAsset(env, url, alt)
  ): Promise<Record<string, unknown>> {
    const meta = getAllBlockMeta()[blockType]
    const imageFields = getImageFields(blockType)
    const fields: Record<string, unknown> = {}

    // Scalar fields
    for (const [key, value] of Object.entries(props)) {
      if (key === "headingLevel") continue
      if (!meta?.fields[key] && !meta?.listFields?.[key]) continue

      if (imageFields.has(key) && typeof value === "string" && value) {
        // Convert image URL to Asset reference
        const altKey = key.replace(/Url$/, "Alt").replace(/^image$/, "imageAlt")
        const alt = typeof props[altKey] === "string" ? (props[altKey] as string) : ""
        const assetId = await resolveAsset(value, alt)
        fields[key] = { [locale]: { sys: { type: "Link", linkType: "Asset", id: assetId } } }
      } else if (meta?.listFields?.[key]) {
        const refTarget = isReferenceList(blockType, key)
        if (refTarget && Array.isArray(value)) {
          // Create child entries for reference lists (e.g., CardGrid.cards → blockCard entries)
          const refs = await Promise.all(
            (value as Record<string, unknown>[]).map(async (item, i) => {
              const childFields = await buildBlockFields(env, "Card", item)
              const childEntry = await env.createEntry(refTarget, { fields: childFields })
              const published = await childEntry.publish()
              return { sys: { type: "Link" as const, linkType: "Entry" as const, id: published.sys.id } }
            })
          )
          fields[key] = { [locale]: refs }
        } else {
          // JSON field for other lists
          fields[key] = { [locale]: value }
        }
      } else {
        fields[key] = { [locale]: value }
      }
    }

    return fields
  }

  return async (pages, config) => {
    const env = await getEnvironment()

    // Cache asset lookups within a single publish to avoid duplicate uploads
    const assetCache = new Map<string, Promise<string>>()
    const cachedEnsureAsset = (imageUrl: string, alt: string) => {
      const cached = assetCache.get(imageUrl)
      if (cached) return cached
      const promise = ensureAsset(env, imageUrl, alt)
      assetCache.set(imageUrl, promise)
      return promise
    }

    // Track all block entry IDs we create/update (for cleanup)
    const allBlockEntryIds = new Set<string>()

    // Upsert each page and its blocks
    const upsertResults = await Promise.allSettled(pages.map(async (page) => {
      // Create/update block entries in parallel
      const blockEntries = await Promise.all(page.blocks.map(async (block) => {
        const contentTypeId = `block${block.type}`
        const blockFields = await buildBlockFields(env, block.type, block.props, cachedEnsureAsset)

        const entryId = `block_${block.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
        let entry: CfEntry

        try {
          entry = await env.getEntry(entryId)
          entry.fields = blockFields
          entry = await entry.update()
          await entry.publish()
        } catch {
          entry = await env.createEntryWithId(contentTypeId, entryId, { fields: blockFields })
          await entry.publish()
        }

        allBlockEntryIds.add(entry.sys.id)
        return { sys: { type: "Link" as const, linkType: "Entry" as const, id: entry.sys.id } }
      }))

      // Upsert the page entry
      const pageFields = {
        slug: { [locale]: page.slug },
        title: { [locale]: page.title },
        pageId: { [locale]: page.id },
        blocks: { [locale]: blockEntries },
        meta: { [locale]: page.meta ?? null },
        updatedAt: { [locale]: page.updatedAt },
      }

      // Find existing page by slug
      const existingPages = await env.getEntries({
        content_type: "page",
        "fields.slug": page.slug,
        limit: 1,
      })

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
      .map((r, i) => `${pages[i]?.slug ?? "?"}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)

    // Upsert site config
    if (config.name || config.logo || config.navLabels) {
      const configFields = {
        configKey: { [locale]: "default" },
        name: { [locale]: config.name ?? "" },
        logo: { [locale]: config.logo ?? "" },
        navLabels: { [locale]: config.navLabels ?? {} },
      }

      const existingConfig = await env.getEntries({
        content_type: "siteConfig",
        "fields.configKey": "default",
        limit: 1,
      })

      let configEntry
      if (existingConfig.items.length > 0) {
        configEntry = existingConfig.items[0]
        configEntry.fields = configFields
        configEntry = await configEntry.update()
      } else {
        configEntry = await env.createEntry("siteConfig", { fields: configFields })
      }

      await configEntry.publish()
    }

    if (failed.length > 0) {
      return { ok: false, error: `Failed to publish: ${failed.join("; ")}` }
    }
    return { ok: true }
  }
}
