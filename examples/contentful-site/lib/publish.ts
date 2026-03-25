import type { OnPublishFn, InlineAsset } from "@ai-site-editor/site-sdk/routes"
import { isSafeImageUrl } from "@ai-site-editor/site-sdk/routes"
import { imageFields, listFieldNames } from "./manifest"

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

  // Upload an image URL as a Contentful Asset, return the asset ID (or null on failure)
  async function ensureAsset(
    env: CfEnv,
    imageUrl: string,
    alt: string,
    assets?: Record<string, InlineAsset>
  ): Promise<string | null> {
    // Check for inline asset (generated/modified images with localhost URLs)
    const inlineAsset = assets?.[imageUrl]
    if (inlineAsset) {
      try {
        const bytes = Buffer.from(inlineAsset.data, "base64")
        const upload = await env.createUpload({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer })
        const asset = await env.createAsset({
          fields: {
            title: { [locale]: alt || inlineAsset.fileName },
            description: { [locale]: imageUrl },
            file: {
              [locale]: {
                contentType: inlineAsset.mimeType,
                fileName: inlineAsset.fileName,
                uploadFrom: { sys: { type: "Link", linkType: "Upload", id: upload.sys.id } },
              },
            },
          },
        })
        const processed = await asset.processForAllLocales()
        const published = await processed.publish()
        return published.sys.id
      } catch (err) {
        console.warn(`[contentful-publish] inline asset upload failed for ${imageUrl}: ${err instanceof Error ? err.message : err}`)
        return null
      }
    }

    // Skip non-http URLs (relative paths, data URIs) or private IPs
    if (!imageUrl.startsWith("http") || !isSafeImageUrl(imageUrl)) {
      try {
        const asset = await env.createAsset({
          fields: {
            title: { [locale]: alt || imageUrl },
            description: { [locale]: imageUrl },
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
      } catch {
        return null
      }
    }

    // Check if asset already exists by source URL stored in description
    try {
      const existing = await env.getAssets({ "fields.description": imageUrl, limit: 1 })
      if (existing.items.length > 0) return existing.items[0].sys.id
    } catch { /* continue to upload */ }

    try {
      const asset = await env.createAsset({
        fields: {
          title: { [locale]: alt || imageUrl },
          description: { [locale]: imageUrl },
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
    } catch (err) {
      console.warn(`[contentful-publish] asset upload failed for ${imageUrl}: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }

  function guessContentType(url: string): string {
    const lower = url.toLowerCase()
    if (lower.includes(".png")) return "image/png"
    if (lower.includes(".webp")) return "image/webp"
    if (lower.includes(".gif")) return "image/gif"
    if (lower.includes(".svg")) return "image/svg+xml"
    return "image/jpeg"
  }

  /** Helper: create an asset link field value */
  function assetLink(assetId: string) {
    return { [locale]: { sys: { type: "Link", linkType: "Asset", id: assetId } } }
  }

  /** Helper: create an entry link */
  function entryLink(entryId: string) {
    return { sys: { type: "Link" as const, linkType: "Entry" as const, id: entryId } }
  }

  /** Extract existing asset ID from a Contentful field value (locale-wrapped asset link) */
  function existingAssetId(fieldValue: unknown): string | null {
    if (!fieldValue || typeof fieldValue !== "object") return null
    const localeVal = (fieldValue as Record<string, unknown>)[locale]
    if (!localeVal || typeof localeVal !== "object") return null
    const sys = (localeVal as Record<string, unknown>).sys as { id?: string; linkType?: string } | undefined
    return sys?.linkType === "Asset" && sys.id ? sys.id : null
  }

  // Build Contentful fields for a block entry, converting images to Asset links.
  // existingFields is the previous entry's fields (for fallback when image upload fails).
  async function buildBlockFields(
    env: CfEnv,
    blockType: string,
    props: Record<string, unknown>,
    resolveAsset: (url: string, alt: string) => Promise<string | null>,
    existingFields?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const imgFields = imageFields.get(blockType) ?? new Set<string>()
    const listFieldsForType = listFieldNames.get(blockType) ?? new Set<string>()
    const fields: Record<string, unknown> = {}

    // Scalar fields
    for (const [key, value] of Object.entries(props)) {
      if (key === "headingLevel") continue

      if (imgFields.has(key) && typeof value === "string" && value) {
        // Convert image URL to Asset reference
        const altKey = key.replace(/Url$/, "Alt").replace(/^image$/, "imageAlt")
        const alt = typeof props[altKey] === "string" ? (props[altKey] as string) : ""
        const assetId = await resolveAsset(value, alt)
        if (assetId) {
          fields[key] = assetLink(assetId)
        } else {
          // Fallback: preserve existing asset from previous publish
          const prevAssetId = existingAssetId(existingFields?.[key])
          if (prevAssetId) {
            fields[key] = assetLink(prevAssetId)
          }
        }
      } else if (listFieldsForType.has(key)) {
        // Handled separately for reference lists (card entries use deterministic IDs)
        if (!isReferenceList(blockType, key)) {
          // JSON field for non-reference lists
          fields[key] = { [locale]: value }
        }
        // Reference lists are built in the main handler with deterministic IDs
      } else {
        fields[key] = { [locale]: value }
      }
    }

    return fields
  }

  return async (pages, config, context) => {
    const env = await getEnvironment()

    // Cache asset lookups within a single publish to avoid duplicate uploads
    const assetCache = new Map<string, Promise<string | null>>()
    const cachedEnsureAsset = (imageUrl: string, alt: string) => {
      const cached = assetCache.get(imageUrl)
      if (cached) return cached
      const promise = ensureAsset(env, imageUrl, alt, context?.assets)
      assetCache.set(imageUrl, promise)
      return promise
    }

    // Upsert each page and its blocks
    const upsertResults = await Promise.allSettled(pages.map(async (page) => {
      const blockEntries = await Promise.all(page.blocks.map(async (block) => {
        const contentTypeId = `block${block.type}`
        const rawId = block.id.startsWith("block_") ? block.id : `block_${block.id}`
        const entryId = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)

        // Fetch existing entry for fallback (image fields) and later upsert
        let existingEntry: CfEntry | null = null
        try {
          existingEntry = await env.getEntry(entryId)
        } catch { /* first publish */ }
        const existingFields = existingEntry?.fields as Record<string, unknown> | undefined

        const blockFields = await buildBlockFields(env, block.type, block.props, cachedEnsureAsset, existingFields)

        // Handle reference lists (CardGrid.cards → blockCard entries with deterministic IDs)
        const blockListFields = listFieldNames.get(block.type) ?? new Set<string>()
        for (const [key, value] of Object.entries(block.props)) {
          const refTarget = isReferenceList(block.type, key)
          if (refTarget && Array.isArray(value) && blockListFields.has(key)) {
            const items = value as Record<string, unknown>[]
            const cardRefs = await Promise.all(
              items.map(async (item, i) => {
                const cardEntryId = `card_${entryId}_${i}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)

                // Fetch existing card entry for image fallback + upsert
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

            // Clean up excess card entries from previous publishes
            // (e.g., CardGrid went from 5 cards to 3 — delete cards at index 3, 4)
            for (let i = items.length; i < items.length + 20; i++) {
              const staleCardId = `card_${entryId}_${i}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
              try {
                const staleCard = await env.getEntry(staleCardId)
                try { await staleCard.unpublish() } catch { /* may already be unpublished */ }
                await staleCard.delete()
              } catch {
                break // no more stale cards
              }
            }
          }
        }

        // Upsert the block entry (reuse fetched entry to avoid double-fetch)
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
