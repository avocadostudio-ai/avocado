import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { resolveDraftContext, isTileMode, single, buildSlug } from "@ai-site-editor/site-sdk"
import { SitePageContent } from "../../components/site-page-content"
import { EditorPageWrapper } from "../../components/editor-wrapper"
import { resolveContentSource, getPage, getNavSlugs, getSiteConfig } from "../../lib/content"
import { getPublishedPage, getPublishedSlugs } from "../../lib/published-content-api"
import { derivePageDescription } from "../../lib/seo"
import { buildNavItems } from "../../lib/navigation"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const EDITOR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" || process.env.NODE_ENV !== "production"

// --- Static generation ---

export function generateStaticParams() {
  return getPublishedSlugs().map((slug) => ({
    slug: slug === "/" ? [] : slug.slice(1).split("/").filter(Boolean)
  }))
}

// --- Metadata ---

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorFallback = EDITOR_ENABLED && single(resolvedSearch.__editor) === "1"
  const contentSource = resolveContentSource(draft.isEnabled || editorFallback)
  if (contentSource === "draft") noStore()

  const session = single(resolvedSearch.session) ?? "dev"
  const siteId = single(resolvedSearch.siteId) ?? "avocado-stories"

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

export default async function SitePage({ params, searchParams }: PageProps) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Resolve editor context (null when editor disabled or not in draft mode)
  const editorCtx = EDITOR_ENABLED
    ? await resolveDraftContext(resolvedSearch, {
        defaultSession: "dev",
        defaultSiteId: "avocado-stories",
        defaultEditorOrigin: process.env.NEXT_PUBLIC_EDITOR_ORIGIN?.replace(/\/+$/, "")
      })
    : null

  const contentSource = resolveContentSource(draft.isEnabled || !!editorCtx)
  if (contentSource === "draft") noStore()

  const editorMode = EDITOR_ENABLED && contentSource === "draft"
  const session = editorCtx?.session ?? "dev"
  const siteId = editorCtx?.siteId ?? "avocado-stories"

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

  const { navItems, siteName, siteLogo, homeHref } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId,
    editorQuery
  })

  if (!page) {
    if (!editorMode) notFound()
    return (
      <main>
        <h1>Draft unavailable</h1>
        <p>Could not load draft content from orchestrator for {slug}.</p>
      </main>
    )
  }

  // Published mode: pure renderer, no editor imports evaluated
  if (!editorMode) {
    return <SitePageContent page={page} navItems={navItems} siteName={siteName} siteLogo={siteLogo} homeHref={homeHref} />
  }

  // Editor mode: wrapper with overlays, block selection, tile mode
  const tileMode = isTileMode(resolvedSearch)
  return (
    <EditorPageWrapper
      page={page}
      navItems={navItems}
      siteName={siteName}
      siteLogo={siteLogo}
      homeHref={homeHref}
      slug={slug}
      editorOrigin={editorOrigin}
      tileMode={tileMode}
    />
  )
}
