import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import type { JSX } from "react"
import { SharedBlockRenderer, BlocksHydrator } from "@ai-site-editor/blocks"
import { buildSlug } from "./index.ts"
import type { BlockInstance } from "./types.ts"
import type { SiteConfig } from "@ai-site-editor/shared"
import { resolveEditorContext, fetchEditorPage, fetchEditorSlugs } from "./draft.ts"
import { renderBlocks, EditorOverlay } from "./editor.ts"
import { buildNavItems, buildSiteHeaderBlock } from "./navigation.ts"
import type { PageDoc } from "@ai-site-editor/shared"

/**
 * Configuration for creating a site page component.
 *
 * Provide your CMS-specific data fetchers and the factory handles:
 * - Draft/editor mode detection and switching
 * - Navigation header and footer chrome
 * - Editor overlay for live editing
 * - Static params generation for build-time rendering
 * - 404 and draft-unavailable fallbacks
 *
 * @example Single-route ("auto") setup — everything in one [[...slug]] route
 * ```ts
 * // app/[[...slug]]/page.tsx
 * import { createSitePage } from "@ai-site-editor/site-sdk/page"
 * import { getPage, getSlugs, getSiteConfig } from "../../lib/my-cms"
 *
 * const { Page, generateStaticParams } = createSitePage({
 *   siteId: "my-site",
 *   getPage,
 *   getSlugs,
 *   getSiteConfig,
 * })
 *
 * export default Page
 * export { generateStaticParams }
 * ```
 *
 * @example Split-route setup — fully static published path + dynamic preview path
 * ```ts
 * // middleware.ts
 * import { createEditorMiddleware } from "@ai-site-editor/site-sdk/middleware"
 * export const { middleware, config } = createEditorMiddleware()
 *
 * // app/[[...slug]]/page.tsx (statically generated)
 * const { Page, generateStaticParams } = createSitePage({ mode: "static", ... })
 * export default Page
 * export { generateStaticParams }
 *
 * // app/preview-draft/[[...slug]]/page.tsx (dynamic editor route)
 * export const dynamic = "force-dynamic"
 * const { Page } = createSitePage({ mode: "preview", ... })
 * export default Page
 * ```
 */
export type SitePageConfig = {
  /** Unique site identifier (used for session scoping) */
  siteId: string
  /** Default session name. Defaults to "dev". */
  session?: string
  /** Fetch a single page by slug from your CMS */
  getPage: (slug: string) => Promise<PageDoc | null>
  /** Fetch all page slugs from your CMS (for static generation) */
  getSlugs: () => Promise<string[]>
  /** Fetch site-wide config (name, logo, nav labels) from your CMS */
  getSiteConfig?: () => Promise<SiteConfig>
  /** Default logo path. Defaults to "/logo.svg". */
  defaultLogo?: string
  /** Footer block to render below content. Omit to hide footer. */
  footer?: BlockInstance
  /** Render site header/footer chrome. Set false when the host layout provides its own. Defaults to true. */
  chrome?: boolean
  /**
   * Rendering mode. Defaults to `"auto"`.
   *
   * - `"auto"`: single-route — handles published and editor modes in one file. Works without middleware.
   * - `"static"`: published-only — no searchParams, no editor logic, fully static. Pair with `createEditorMiddleware()` and a separate `mode: "preview"` route.
   * - `"preview"`: editor-only — always reads searchParams + draft content. Set `export const dynamic = "force-dynamic"` on the route file.
   */
  mode?: "auto" | "static" | "preview"
}

type StaticPageProps = {
  params: Promise<{ slug?: string[] }>
}

type DynamicPageProps = StaticPageProps & {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

type ResolvedConfig = {
  siteId: string
  defaultSession: string
  cmsGetPage: SitePageConfig["getPage"]
  cmsGetSlugs: SitePageConfig["getSlugs"]
  cmsGetSiteConfig: SitePageConfig["getSiteConfig"]
  defaultLogo: string
  footer: BlockInstance | undefined
  chrome: boolean
}

function resolve(config: SitePageConfig): ResolvedConfig {
  return {
    siteId: config.siteId,
    defaultSession: config.session ?? "dev",
    cmsGetPage: config.getPage,
    cmsGetSlugs: config.getSlugs,
    cmsGetSiteConfig: config.getSiteConfig,
    defaultLogo: config.defaultLogo ?? "/logo.svg",
    footer: config.footer,
    chrome: config.chrome ?? true,
  }
}

function makeGenerateStaticParams(cmsGetSlugs: SitePageConfig["getSlugs"]) {
  return async function generateStaticParams() {
    const slugs = await cmsGetSlugs()
    return slugs.map((slug) => ({
      slug: slug === "/" ? undefined : slug.replace(/^\//, "").split("/"),
    }))
  }
}

async function renderStatic(slug: string, c: ResolvedConfig): Promise<JSX.Element> {
  const [page, navSlugs, siteConfig] = await Promise.all([
    c.cmsGetPage(slug),
    c.cmsGetSlugs(),
    c.cmsGetSiteConfig ? c.cmsGetSiteConfig() : Promise.resolve({} as SiteConfig),
  ])

  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId: c.siteId,
    editorQuery: "",
    defaultLogo: c.defaultLogo,
  })
  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

  if (!page) {
    return (
      <>
        {c.chrome && <SharedBlockRenderer block={chromeHeader} />}
        <main style={{ padding: "4rem", textAlign: "center" }}>
          <h1>404</h1>
          <p>Page not found.</p>
        </main>
        {c.chrome && c.footer ? <SharedBlockRenderer block={c.footer} /> : null}
      </>
    )
  }

  return (
    <>
      {c.chrome && <SharedBlockRenderer block={chromeHeader} />}
      <main>
        {renderBlocks(page.blocks)}
        <BlocksHydrator />
      </main>
      {c.chrome && c.footer ? <SharedBlockRenderer block={c.footer} /> : null}
    </>
  )
}

async function renderPreview(
  slug: string,
  search: Record<string, string | string[] | undefined>,
  c: ResolvedConfig,
): Promise<JSX.Element> {
  noStore()

  const editorCtx = await resolveEditorContext(search, {
    defaultSession: c.defaultSession,
    defaultSiteId: c.siteId,
  })

  const session = editorCtx?.session ?? c.defaultSession
  const currentSiteId = editorCtx?.siteId ?? c.siteId

  const [page, navSlugs, siteConfig] = await Promise.all([
    fetchEditorPage(slug, session, currentSiteId).then((p) => p ?? c.cmsGetPage(slug)),
    fetchEditorSlugs(session, currentSiteId).then((s) => (s.length > 0 ? s : c.cmsGetSlugs())),
    c.cmsGetSiteConfig ? c.cmsGetSiteConfig() : Promise.resolve({} as SiteConfig),
  ])

  const editorOrigin = editorCtx?.editorOrigin ?? ""
  const editorQuery = (() => {
    const p = new URLSearchParams({ session, siteId: currentSiteId })
    if (editorOrigin) p.set("editorOrigin", editorOrigin)
    return `?${p.toString()}`
  })()

  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId: c.siteId,
    editorQuery,
    defaultLogo: c.defaultLogo,
  })
  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

  if (!page) {
    return (
      <>
        {c.chrome && <SharedBlockRenderer block={chromeHeader} />}
        <main style={{ padding: "4rem", textAlign: "center" }}>
          <h1>Draft unavailable</h1>
          <p>Could not load draft content for {slug}.</p>
        </main>
        {c.chrome && c.footer ? <SharedBlockRenderer block={c.footer} /> : null}
      </>
    )
  }

  return (
    <>
      {c.chrome && <SharedBlockRenderer block={chromeHeader} />}
      <main className="editor-mode">{renderBlocks(page.blocks, { editable: true })}</main>
      {c.chrome && c.footer ? <SharedBlockRenderer block={c.footer} /> : null}
      <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
    </>
  )
}

async function renderAuto(
  slug: string,
  search: Record<string, string | string[] | undefined>,
  c: ResolvedConfig,
): Promise<JSX.Element> {
  const editorCtx = await resolveEditorContext(search, {
    defaultSession: c.defaultSession,
    defaultSiteId: c.siteId,
  })

  const draft = await draftMode()
  const editorMode = draft.isEnabled || !!editorCtx

  if (editorMode) {
    return renderPreview(slug, search, c)
  }
  return renderStatic(slug, c)
}

/**
 * Create a Next.js page component with full editor integration.
 *
 * Returns `{ Page, generateStaticParams }` — export them from your route file.
 * See {@link SitePageConfig.mode} for the three rendering modes.
 */
export function createSitePage(config: SitePageConfig) {
  const c = resolve(config)
  const mode = config.mode ?? "auto"
  const generateStaticParams = makeGenerateStaticParams(c.cmsGetSlugs)

  if (mode === "static") {
    async function Page({ params }: StaticPageProps) {
      const { slug: slugParts } = await params
      const slug = buildSlug(slugParts)
      return renderStatic(slug, c)
    }
    return { Page, generateStaticParams }
  }

  if (mode === "preview") {
    async function Page({ params, searchParams }: DynamicPageProps) {
      const [{ slug: slugParts }, search] = await Promise.all([params, searchParams])
      const slug = buildSlug(slugParts)
      return renderPreview(slug, search, c)
    }
    return { Page, generateStaticParams }
  }

  async function Page({ params, searchParams }: DynamicPageProps) {
    const [{ slug: slugParts }, search] = await Promise.all([params, searchParams])
    const slug = buildSlug(slugParts)
    return renderAuto(slug, search, c)
  }
  return { Page, generateStaticParams }
}
