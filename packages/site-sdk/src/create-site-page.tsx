import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
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
 * @example
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
}

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Create a Next.js page component with full editor integration.
 *
 * Returns `{ Page, generateStaticParams }` — export them from your
 * `app/[[...slug]]/page.tsx` route.
 */
export function createSitePage(config: SitePageConfig) {
  const {
    siteId,
    session: defaultSession = "dev",
    getPage: cmsGetPage,
    getSlugs: cmsGetSlugs,
    getSiteConfig: cmsGetSiteConfig,
    defaultLogo = "/logo.svg",
    footer,
    chrome = true,
  } = config

  async function generateStaticParams() {
    const slugs = await cmsGetSlugs()
    return slugs.map((slug) => ({
      slug: slug === "/" ? undefined : slug.replace(/^\//, "").split("/"),
    }))
  }

  async function Page({ params, searchParams }: PageProps) {
    const resolvedParams = await params
    const resolvedSearch = await searchParams
    const slug = buildSlug(resolvedParams.slug)

    const editorCtx = await resolveEditorContext(resolvedSearch, {
      defaultSession,
      defaultSiteId: siteId,
    })

    const draft = await draftMode()
    const editorMode = draft.isEnabled || !!editorCtx

    const session = editorCtx?.session ?? defaultSession
    const currentSiteId = editorCtx?.siteId ?? siteId

    if (editorMode) noStore()

    const [pageResult, navSlugs, siteConfig] = await Promise.all([
      editorMode
        ? fetchEditorPage(slug, session, currentSiteId).then((p) => p ?? cmsGetPage(slug))
        : cmsGetPage(slug),
      editorMode
        ? fetchEditorSlugs(session, currentSiteId).then((s) => s.length > 0 ? s : cmsGetSlugs())
        : cmsGetSlugs(),
      cmsGetSiteConfig ? cmsGetSiteConfig() : Promise.resolve({}),
    ])

    const editorOrigin = editorCtx?.editorOrigin ?? ""
    const editorQuery = editorMode
      ? (() => {
          const p = new URLSearchParams({ session, siteId: currentSiteId })
          if (editorOrigin) p.set("editorOrigin", editorOrigin)
          return `?${p.toString()}`
        })()
      : ""

    const { navItems, siteName, siteLogo } = buildNavItems({
      navSlugs,
      currentSlug: slug,
      siteConfig,
      siteId,
      editorQuery,
      defaultLogo,
    })
    const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

    if (!pageResult) {
      return (
        <>
          {chrome && <SharedBlockRenderer block={chromeHeader} />}
          <main style={{ padding: "4rem", textAlign: "center" }}>
            <h1>{editorMode ? "Draft unavailable" : "404"}</h1>
            <p>{editorMode ? `Could not load draft content for ${slug}.` : "Page not found."}</p>
          </main>
          {chrome && footer ? <SharedBlockRenderer block={footer} /> : null}
        </>
      )
    }

    if (editorMode) {
      return (
        <>
          {chrome && <SharedBlockRenderer block={chromeHeader} />}
          <main className="editor-mode">
            {renderBlocks(pageResult.blocks, { editable: true })}
          </main>
          {chrome && footer ? <SharedBlockRenderer block={footer} /> : null}
          <EditorOverlay slug={slug} editorOrigin={editorOrigin} />
        </>
      )
    }

    return (
      <>
        {chrome && <SharedBlockRenderer block={chromeHeader} />}
        <main>
          {renderBlocks(pageResult.blocks)}
          <BlocksHydrator />
        </main>
        {chrome && footer ? <SharedBlockRenderer block={footer} /> : null}
      </>
    )
  }

  return { Page, generateStaticParams }
}
