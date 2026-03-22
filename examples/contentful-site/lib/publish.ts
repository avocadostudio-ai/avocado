import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"

export interface ContentfulPublishOptions {
  spaceId: string
  environmentId?: string
  managementToken: string
  /** Contentful content type ID for pages. Default: "page" */
  pageContentTypeId?: string
  /** Contentful content type ID for site config. Default: "siteConfig" */
  configContentTypeId?: string
  /** Contentful locale. Default: "en-US" */
  locale?: string
}

/**
 * Publish handler that upserts PageDoc entries to Contentful via the Management API.
 *
 * Prerequisites:
 * - Create content types in Contentful (use the setup script or manually):
 *   - `page`: fields slug (Short text, unique), title (Short text), pageId (Short text),
 *     blocks (JSON), meta (JSON), updatedAt (Date & time)
 *   - `siteConfig`: fields configKey (Short text, unique), name (Short text),
 *     logo (Short text), navLabels (JSON)
 *
 * Usage:
 * ```ts
 * import { createContentfulPublishHandler } from "../lib/publish"
 *
 * createEditorApiHandler({
 *   getPages: () => [...],
 *   onPublish: createContentfulPublishHandler({
 *     spaceId: process.env.CONTENTFUL_SPACE_ID!,
 *     managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN!,
 *   }),
 * })
 * ```
 */
export function createContentfulPublishHandler(opts: ContentfulPublishOptions): OnPublishFn {
  const pageContentType = opts.pageContentTypeId ?? "page"
  const configContentType = opts.configContentTypeId ?? "siteConfig"
  const locale = opts.locale ?? "en-US"

  // Cache the environment reference — spaceId and environmentId are fixed at creation time
  let cachedEnvPromise: ReturnType<typeof loadEnvironment> | null = null

  async function loadEnvironment() {
    // CJS/ESM interop: contentful-management may export createClient on default or as named
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
        cachedEnvPromise = null // Allow retry on next publish
        throw err
      })
    }
    return cachedEnvPromise
  }

  return async (pages, config) => {
    const env = await getEnvironment()

    // Bulk-fetch all existing page entries once to avoid per-page lookups
    const allEntries = await env.getEntries({
      content_type: pageContentType,
      limit: 1000,
    })
    const entryBySlug = new Map<string, (typeof allEntries.items)[0]>()
    for (const entry of allEntries.items) {
      const slug = entry.fields.slug?.[locale] as string | undefined
      if (slug) entryBySlug.set(slug, entry)
    }

    const publishedSlugs = new Set(pages.map((p) => p.slug))

    // Upsert pages in parallel — use allSettled to report partial failures
    const upsertResults = await Promise.allSettled(pages.map(async (page) => {
      const fields = {
        slug: { [locale]: page.slug },
        title: { [locale]: page.title },
        pageId: { [locale]: page.id },
        blocks: { [locale]: page.blocks },
        meta: { [locale]: page.meta ?? null },
        updatedAt: { [locale]: page.updatedAt },
      }

      const existing = entryBySlug.get(page.slug)
      let entry
      if (existing) {
        existing.fields = fields
        entry = await existing.update()
      } else {
        entry = await env.createEntry(pageContentType, { fields })
      }
      await entry.publish()
      return page.slug
    }))

    const failed = upsertResults
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r, i) => `${pages[i]?.slug ?? "?"}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)

    // Delete pages that no longer exist (in parallel)
    const deletions = allEntries.items.filter((entry) => {
      const slug = entry.fields.slug?.[locale] as string | undefined
      return slug && !publishedSlugs.has(slug)
    })
    await Promise.allSettled(deletions.map(async (entry) => {
      if (entry.isPublished()) await entry.unpublish()
      await entry.delete()
    }))

    // Upsert site config
    if (config.name || config.logo || config.navLabels) {
      const configFields = {
        configKey: { [locale]: "default" },
        name: { [locale]: config.name ?? "" },
        logo: { [locale]: config.logo ?? "" },
        navLabels: { [locale]: config.navLabels ?? {} },
      }

      const existingConfig = await env.getEntries({
        content_type: configContentType,
        "fields.configKey": "default",
        limit: 1,
      })

      let configEntry
      if (existingConfig.items.length > 0) {
        configEntry = existingConfig.items[0]
        configEntry.fields = configFields
        configEntry = await configEntry.update()
      } else {
        configEntry = await env.createEntry(configContentType, { fields: configFields })
      }

      await configEntry.publish()
    }

    if (failed.length > 0) {
      return { ok: false, error: `Failed to publish: ${failed.join("; ")}` }
    }
    return { ok: true }
  }
}
