import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { buildSlug, single } from "@ai-site-editor/site-sdk"
import { resolveEditorContext } from "@ai-site-editor/site-sdk/draft"
import { SitePageContent } from "../../../components/site-page-content"
import { EditorPageWrapper } from "../../../components/editor-wrapper"
import { ImmersivePageWrapper } from "../../../components/immersive-wrapper"
import { resolveContentSource, getPage, getNavSlugs, getSiteConfig } from "../../../lib/content"
import { getPublishedPage } from "../../../lib/published-content-api"
import { derivePageDescription } from "../../../lib/seo"
import { buildNavItems, buildSiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
import { DEFAULT_SITE_ID, DEFAULT_SESSION } from "../../../lib/defaults"
import { ThemeOverrides } from "../../../components/theme-overrides"

export const dynamic = "force-dynamic"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// --- Metadata ---

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorFallback = single(resolvedSearch.__editor) === "1"
  const contentSource = resolveContentSource(draft.isEnabled || editorFallback)
  if (contentSource === "draft") noStore()

  const session = single(resolvedSearch.session) ?? DEFAULT_SESSION
  const siteId = single(resolvedSearch.siteId) ?? DEFAULT_SITE_ID

  const page = contentSource === "draft"
    ? await getPage(slug, contentSource, session, siteId)
    : getPublishedPage(slug)
  if (!page) return {}

  const description = derivePageDescription(page)
  return {
    title: page.meta?.title ?? page.title,
    description,
    openGraph: { description, ...(page.meta?.ogImage ? { images: [page.meta.ogImage] } : {}) }
  }
}

// --- Page ---

export default async function PreviewPage({ params, searchParams }: PageProps) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Resolve editor context
  const editorCtx = await resolveEditorContext(resolvedSearch, {
    defaultSession: DEFAULT_SESSION,
    defaultSiteId: DEFAULT_SITE_ID,
    defaultEditorOrigin: process.env.NEXT_PUBLIC_EDITOR_ORIGIN?.replace(/\/+$/, "")
  })

  const contentSource = resolveContentSource(draft.isEnabled || !!editorCtx)
  if (contentSource === "draft") noStore()

  const editorMode = contentSource === "draft"
  const session = editorCtx?.session ?? DEFAULT_SESSION
  const siteId = editorCtx?.siteId ?? DEFAULT_SITE_ID

  // Fetch content — use allSettled so partial failures degrade gracefully
  const [pageResult, navSlugsResult, siteConfigResult] = await Promise.allSettled([
    getPage(slug, contentSource, session, siteId),
    getNavSlugs(contentSource, session, siteId),
    getSiteConfig(contentSource, session, siteId)
  ])

  const page = pageResult.status === "fulfilled" ? pageResult.value : null
  const navSlugs = navSlugsResult.status === "fulfilled" ? navSlugsResult.value : []
  const siteConfig = siteConfigResult.status === "fulfilled" ? siteConfigResult.value : { name: "", logo: "" }

  // Build navigation
  const editorOrigin = editorCtx?.editorOrigin ?? ""
  const editorQuery = editorMode
    ? (() => {
        const p = new URLSearchParams({ session, siteId })
        if (editorOrigin) p.set("editorOrigin", editorOrigin)
        return `?${p.toString()}`
      })()
    : ""

  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId,
    editorQuery
  })

  if (!page) {
    if (!editorMode) notFound()
    return (
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "60vh",
          gap: "20px",
          padding: "24px",
          textAlign: "center",
        }}
      >
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--body-secondary, #888)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9.5" y1="12.5" x2="14.5" y2="17.5" />
          <line x1="14.5" y1="12.5" x2="9.5" y2="17.5" />
        </svg>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 600,
            color: "var(--heading)",
            margin: 0,
          }}
        >
          Draft unavailable
        </h1>
        <p
          style={{
            maxWidth: "28rem",
            color: "var(--body-secondary)",
            margin: 0,
          }}
        >
          Could not load draft content from orchestrator for <code>{slug}</code>.
          <br />
          Make sure the orchestrator is running and try refreshing.
        </p>
      </main>
    )
  }

  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

  // Theme overrides apply to all render modes
  const themeOverlay = <ThemeOverrides siteConfig={siteConfig} />

  // Published mode (draft cookie but no editor query): pure renderer
  if (!editorMode) {
    return <>{themeOverlay}<SitePageContent page={page} chromeHeader={chromeHeader} /></>
  }

  // Immersive mode: widget rendered directly on page, no iframe needed
  const isImmersive = single(resolvedSearch.immersive) === "1"
  if (isImmersive) {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL?.replace(/\/+$/, "") ?? "http://localhost:4200"
    const immersiveQuery = (() => {
      const p = new URLSearchParams({ session, siteId, __editor: "1", immersive: "1" })
      return `?${p.toString()}`
    })()
    const immersiveNav = buildNavItems({ navSlugs, currentSlug: slug, siteConfig, siteId, editorQuery: immersiveQuery })
    const immersiveHeader = buildSiteHeaderBlock({ navItems: immersiveNav.navItems, siteName: immersiveNav.siteName, siteLogo: immersiveNav.siteLogo, activePath: slug })
    return (
      <>
        {themeOverlay}
        <ImmersivePageWrapper
          page={page}
          chromeHeader={immersiveHeader}
          slug={slug}
          config={{ orchestratorUrl, session, siteId }}
          siteContext={{ siteName: siteConfig.name }}
        />
      </>
    )
  }

  // Editor mode: wrapper with overlays and block selection (iframe)
  return (
    <>
      {themeOverlay}
      <EditorPageWrapper page={page} chromeHeader={chromeHeader} slug={slug} editorOrigin={editorOrigin} />
    </>
  )
}
