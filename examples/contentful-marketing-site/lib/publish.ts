import type { OnPublishFn, InlineAsset } from "@ai-site-editor/site-sdk/routes"
import { isSafeImageUrl } from "@ai-site-editor/site-sdk/routes"
import { plainTextToDocument } from "./rich-text"

export interface MarketingPublishOptions {
  spaceId: string
  environmentId?: string
  managementToken: string
  locale?: string
}

/**
 * Publish handler for the Contentful marketing webapp template content model.
 *
 * BlockInstance types map to template content types:
 *   CtfHeroBanner   → componentHeroBanner
 *   CtfDuplex       → componentDuplex
 *   CtfInfoBlock    → componentInfoBlock
 *   CtfCta          → componentCta
 *   CtfQuote        → componentQuote
 *   CtfTextBlock    → componentTextBlock
 *   CtfPerson       → topicPerson
 *   CtfProduct      → topicProduct
 *   CtfBusinessInfo → topicBusinessInfo
 *   CtfProductTable → componentProductTable
 *   CtfFooter       → componentFooter
 *
 * Pages are laid out as:
 *   - first CtfHeroBanner (if any) → page.topSection
 *   - everything else              → page.content[] (polymorphic refs)
 */
export function createMarketingPublishHandler(opts: MarketingPublishOptions): OnPublishFn {
  const locale = opts.locale ?? "en-US"

  // Lazily-imported contentful-management environment.
  // We can't `import type` at the top because contentful-management is a CJS
  // module with a complex deep type graph; the runtime `import()` inside
  // loadEnvironment keeps the dep optional for bundlers.
  type CfEnv = Record<string, any>
  type CfEntry = Record<string, any>

  let cachedEnvPromise: Promise<CfEnv> | null = null

  async function loadEnvironment(): Promise<CfEnv> {
    const mod = await import("contentful-management")
    const createClient =
      (mod as { createClient?: typeof mod.createClient }).createClient ??
      (mod as unknown as { default: { createClient: typeof mod.createClient } }).default.createClient
    const client = createClient({ accessToken: opts.managementToken })
    const space = await client.getSpace(opts.spaceId)
    return (await space.getEnvironment(opts.environmentId ?? "master")) as unknown as CfEnv
  }

  function getEnvironment(): Promise<CfEnv> {
    if (!cachedEnvPromise) {
      cachedEnvPromise = loadEnvironment().catch((err) => {
        cachedEnvPromise = null
        throw err
      })
    }
    return cachedEnvPromise
  }

  // -------------------------------------------------------------------------
  // Asset upload + dedup
  // -------------------------------------------------------------------------

  type AssetResult = { id: string; url: string }

  function guessContentType(url: string): string {
    const lower = url.toLowerCase()
    if (lower.includes(".png")) return "image/png"
    if (lower.includes(".webp")) return "image/webp"
    if (lower.includes(".gif")) return "image/gif"
    if (lower.includes(".svg")) return "image/svg+xml"
    return "image/jpeg"
  }

  function assetUrlFromPublished(asset: { fields: Record<string, unknown> }): string {
    const file = (asset.fields.file as Record<string, unknown> | undefined)?.[locale] as { url?: string } | undefined
    const url = file?.url
    if (!url) return ""
    return url.startsWith("//") ? `https:${url}` : url
  }

  async function ensureAsset(
    env: CfEnv,
    imageUrl: string,
    alt: string,
    assets?: Record<string, InlineAsset>,
  ): Promise<AssetResult | null> {
    if (!imageUrl) return null

    const inline = assets?.[imageUrl]
    if (inline) {
      try {
        const bytes = Buffer.from(inline.data, "base64")
        const upload = await env.createUpload({
          file: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        })
        const asset = await env.createAsset({
          fields: {
            title: { [locale]: alt || inline.fileName },
            description: { [locale]: imageUrl },
            file: {
              [locale]: {
                contentType: inline.mimeType,
                fileName: inline.fileName,
                uploadFrom: { sys: { type: "Link", linkType: "Upload", id: upload.sys.id } },
              },
            },
          },
        })
        const processed = await asset.processForAllLocales()
        const published = await processed.publish()
        return { id: published.sys.id, url: assetUrlFromPublished(published) }
      } catch (err) {
        console.warn(
          `[marketing-publish] inline asset upload failed for ${imageUrl}: ${err instanceof Error ? err.message : err}`,
        )
        return null
      }
    }

    if (!imageUrl.startsWith("http") || !isSafeImageUrl(imageUrl)) return null

    try {
      const existing = await env.getAssets({ "fields.description": imageUrl, limit: 1 })
      if (existing.items.length > 0) {
        const hit = existing.items[0]
        return { id: hit.sys.id, url: assetUrlFromPublished(hit) }
      }
    } catch {
      /* fall through to upload */
    }

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
      return { id: published.sys.id, url: assetUrlFromPublished(published) }
    } catch (err) {
      console.warn(
        `[marketing-publish] asset upload failed for ${imageUrl}: ${err instanceof Error ? err.message : err}`,
      )
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Field-builder helpers
  // -------------------------------------------------------------------------

  const fv = <T>(v: T) => ({ [locale]: v })
  const assetLink = (id: string) => fv({ sys: { type: "Link", linkType: "Asset", id } })
  const entryLinkBare = (id: string) => ({ sys: { type: "Link" as const, linkType: "Entry" as const, id } })

  function asString(v: unknown, fallback = ""): string {
    return typeof v === "string" ? v : fallback
  }

  async function lookupPageLinkByHref(
    env: CfEnv,
    href: string,
    pageIdsBySlug: Map<string, string>,
  ): Promise<{ sys: { type: "Link"; linkType: "Entry"; id: string } } | null> {
    if (!href || href === "#") return null
    const slug = href === "/" ? "home" : href.replace(/^\//, "")
    const cached = pageIdsBySlug.get(slug)
    if (cached) return entryLinkBare(cached)

    try {
      const existing = await env.getEntries({
        content_type: "page",
        "fields.slug": slug,
        limit: 1,
      })
      if (existing.items.length > 0) {
        const id = existing.items[0].sys.id
        pageIdsBySlug.set(slug, id)
        return entryLinkBare(id)
      }
    } catch {
      /* ignore */
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Per-block-type field builders (returning the raw Contentful fields map).
  // Each builder is responsible for image uploads specific to its block.
  // -------------------------------------------------------------------------

  type BuildCtx = {
    env: CfEnv
    resolveAsset: (url: string, alt: string) => Promise<AssetResult | null>
    resolveTargetPage: (href: string) => Promise<ReturnType<typeof entryLinkBare> | null>
  }

  type Builder = (ctx: BuildCtx, props: Record<string, unknown>) => Promise<Record<string, unknown>>

  // Common body/headline fragments
  async function withImageLink(ctx: BuildCtx, url: string, alt: string, fieldName: string) {
    if (!url) return {}
    const asset = await ctx.resolveAsset(url, alt)
    if (!asset) return {}
    return { [fieldName]: assetLink(asset.id) }
  }

  async function withTargetPage(ctx: BuildCtx, href: string, fieldName = "targetPage") {
    const link = await ctx.resolveTargetPage(href)
    if (!link) return {}
    return { [fieldName]: fv(link) }
  }

  const builders: Record<string, { contentType: string; build: Builder }> = {
    CtfHeroBanner: {
      contentType: "componentHeroBanner",
      build: async (ctx, props) => {
        return {
          headline: fv(asString(props.headline)),
          bodyText: fv(plainTextToDocument(asString(props.bodyText))),
          ctaText: fv(asString(props.ctaText)),
          colorPalette: fv(asString(props.colorPalette)),
          heroSize: fv(asString(props.heroSize) === "fixed_height" ? false : true),
          imageStyle: fv(asString(props.imageStyle) === "partial" ? true : false),
          ...(await withImageLink(ctx, asString(props.imageUrl), asString(props.headline), "image")),
          ...(await withTargetPage(ctx, asString(props.targetPage))),
        }
      },
    },

    CtfDuplex: {
      contentType: "componentDuplex",
      build: async (ctx, props) => {
        return {
          headline: fv(asString(props.headline)),
          bodyText: fv(plainTextToDocument(asString(props.bodyText))),
          ctaText: fv(asString(props.ctaText)),
          containerLayout: fv(asString(props.containerLayout) === "image_right"),
          colorPalette: fv(asString(props.colorPalette)),
          ...(await withImageLink(ctx, asString(props.imageUrl), asString(props.headline), "image")),
          ...(await withTargetPage(ctx, asString(props.targetPage))),
        }
      },
    },

    CtfInfoBlock: {
      contentType: "componentInfoBlock",
      build: async (_ctx, props) => ({
        headline: fv(asString(props.headline)),
        subline: fv(asString(props.subline)),
        body: fv(plainTextToDocument(asString(props.body))),
        icon: fv(asString(props.icon, "markdown")),
        colorPalette: fv(asString(props.colorPalette)),
      }),
    },

    CtfCta: {
      contentType: "componentCta",
      build: async (ctx, props) => ({
        headline: fv(asString(props.headline)),
        subline: fv(asString(props.subline)),
        ctaText: fv(asString(props.ctaText)),
        colorPalette: fv(asString(props.colorPalette)),
        ...(await withImageLink(ctx, asString(props.imageUrl), asString(props.headline), "image")),
        ...(await withTargetPage(ctx, asString(props.targetPage))),
      }),
    },

    CtfQuote: {
      contentType: "componentQuote",
      build: async (ctx, props) => ({
        quote: fv(plainTextToDocument(asString(props.quote))),
        imageAlignment: fv(asString(props.imageAlignment) === "right"),
        colorPalette: fv(asString(props.colorPalette)),
        ...(await withImageLink(ctx, asString(props.imageUrl), "", "image")),
      }),
    },

    CtfTextBlock: {
      contentType: "componentTextBlock",
      build: async (_ctx, props) => ({
        headline: fv(asString(props.headline)),
        subline: fv(asString(props.subline)),
        body: fv(plainTextToDocument(asString(props.body))),
      }),
    },

    CtfPerson: {
      contentType: "topicPerson",
      build: async (ctx, props) => ({
        name: fv(asString(props.name)),
        cardStyle: fv(asString(props.cardStyle) === "compact"),
        shortBio: fv(plainTextToDocument(asString(props.shortBio))),
        ...(await withImageLink(ctx, asString(props.avatarUrl), asString(props.name), "avatar")),
      }),
    },

    CtfProduct: {
      contentType: "topicProduct",
      build: async (ctx, props) => ({
        name: fv(asString(props.name)),
        description: fv(plainTextToDocument(asString(props.description))),
        pricing: fv(asString(props.pricing)),
        ...(await withImageLink(ctx, asString(props.imageUrl), asString(props.name), "featuredImage")),
        // NOTE: feature list items are stored as a JSON array instead of
        // separate feature entries. Known limitation.
        features: fv(Array.isArray(props.features) ? props.features : []),
      }),
    },

    CtfBusinessInfo: {
      contentType: "topicBusinessInfo",
      build: async (ctx, props) => ({
        name: fv(asString(props.name)),
        shortDescription: fv(asString(props.shortDescription)),
        longDescription: fv(plainTextToDocument(asString(props.longDescription))),
        ...(await withImageLink(ctx, asString(props.imageUrl), asString(props.name), "featuredImage")),
      }),
    },

    CtfProductTable: {
      contentType: "componentProductTable",
      build: async (_ctx, props) => ({
        headline: fv(asString(props.headline)),
        subline: fv(asString(props.subline)),
        // NOTE: product rows stored as inline JSON instead of references to
        // topicProduct entries. Known limitation.
        products: fv(Array.isArray(props.products) ? props.products : []),
      }),
    },

    CtfFooter: {
      contentType: "componentFooter",
      build: async (_ctx, props) => ({
        copyright: fv(asString(props.copyright)),
        // NOTE: stored as JSON instead of page link array. Known limitation.
        menuItems: fv(Array.isArray(props.menuItems) ? props.menuItems : []),
      }),
    },
  }

  // -------------------------------------------------------------------------
  // Main handler
  // -------------------------------------------------------------------------

  return async (pages, _siteConfig, context) => {
    const env = await getEnvironment()

    const assetCache = new Map<string, Promise<AssetResult | null>>()
    const resolveAsset = (url: string, alt: string) => {
      const cached = assetCache.get(url)
      if (cached) return cached
      const promise = ensureAsset(env, url, alt, context?.assets)
      assetCache.set(url, promise)
      return promise
    }

    const pageIdsBySlug = new Map<string, string>()
    const resolveTargetPage = (href: string) => lookupPageLinkByHref(env, href, pageIdsBySlug)

    const ctx: BuildCtx = { env, resolveAsset, resolveTargetPage }

    const upsertResults = await Promise.allSettled(
      pages.map(async (page) => {
        // Build block entries first
        const blockLinks: Array<ReturnType<typeof entryLinkBare>> = []
        let topSectionLink: ReturnType<typeof entryLinkBare> | null = null

        for (const [index, block] of page.blocks.entries()) {
          const builder = builders[block.type]
          if (!builder) {
            console.warn(`[marketing-publish] skipping unknown block type: ${block.type}`)
            continue
          }

          const rawId = block.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `block_${index}`
          const entryId = rawId.length < 3 ? `block_${rawId}_${index}` : rawId

          const fields = await builder.build(ctx, block.props)

          let existing: CfEntry | null = null
          try {
            existing = (await env.getEntry(entryId)) as unknown as CfEntry
          } catch {
            /* first publish */
          }

          let published: CfEntry
          if (existing) {
            existing.fields = fields
            const updated = await existing.update()
            published = (await updated.publish()) as unknown as CfEntry
          } else {
            const created = await env.createEntryWithId(builder.contentType, entryId, { fields })
            published = (await created.publish()) as unknown as CfEntry
          }

          const link = entryLinkBare(published.sys.id)
          // First HeroBanner → topSection; everything else → content[]
          if (block.type === "CtfHeroBanner" && !topSectionLink) {
            topSectionLink = link
          } else {
            blockLinks.push(link)
          }
        }

        const slug = page.slug === "/" ? "home" : page.slug.replace(/^\//, "")
        const pageFields: Record<string, unknown> = {
          slug: fv(slug),
          pageName: fv(page.title),
          content: fv(blockLinks),
        }
        if (topSectionLink) pageFields.topSection = fv(topSectionLink)

        const existingPages = await env.getEntries({
          content_type: "page",
          "fields.slug": slug,
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
      }),
    )

    const failed = upsertResults
      .map((r, i) => ({ r, slug: pages[i]?.slug ?? "?" }))
      .filter(({ r }) => r.status === "rejected")
      .map(({ r, slug }) => {
        const reason = (r as PromiseRejectedResult).reason
        return `${slug}: ${reason instanceof Error ? reason.message : String(reason)}`
      })

    if (failed.length > 0) {
      return { ok: false, error: `Failed to publish: ${failed.join("; ")}` }
    }
    return { ok: true }
  }
}
