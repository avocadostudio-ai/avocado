import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import type { Metadata } from "next"
import { resolveDraftContext, isTileMode, single, buildSlug } from "@ai-site-editor/site-sdk"
import { SitePageContent } from "../../components/site-page-content"
import { EditorPageWrapper } from "../../components/editor-wrapper"
import { resolveContentSource, getPage, getNavSlugs, getSiteConfig } from "../../lib/content"
import { getPublishedPage, getPublishedSlugs } from "../../lib/published-content-api"
import { derivePageDescription } from "../../lib/seo"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const EDITOR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" || process.env.NODE_ENV !== "production"

// --- Site-specific presentation helpers ---

function siteNameFallback(siteId: string) {
  return siteId.split("-").filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")
}

function slugToLabel(route: string) {
  if (route === "/") return "Home"
  return route.slice(1).split("/").filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
}

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

  // Fetch content
  const [page, navSlugs, siteConfig] = await Promise.all([
    getPage(slug, contentSource, session, siteId),
    getNavSlugs(contentSource, session, siteId),
    getSiteConfig(contentSource, session, siteId)
  ])

  // Build navigation
  const siteName = siteConfig.name || siteNameFallback(siteId) || "Site"
  const siteLogo = siteConfig.logo || "/logos/default.svg"
  const allSlugs = Array.from(new Set([...(navSlugs.length > 0 ? navSlugs : ["/", "/pricing"]), slug]))
  const orderedSlugs = allSlugs.includes("/") ? ["/", ...allSlugs.filter((r) => r !== "/")] : allSlugs

  // Editor mode: propagate query params through nav links
  const editorOrigin = editorCtx?.editorOrigin ?? ""
  const editorQuery = editorMode
    ? (() => {
        const p = new URLSearchParams({ session, siteId })
        if (editorOrigin) p.set("editorOrigin", editorOrigin)
        return `?${p.toString()}`
      })()
    : ""

  const navItems = orderedSlugs.map((route) => ({
    href: `${route}${editorQuery}`,
    label: siteConfig.navLabels?.[route] ?? slugToLabel(route),
    isActive: route === slug
  }))
  const homeHref = `/${editorQuery}`

  if (!page) {
    return (
      <main>
        <h1>{editorMode ? "Draft unavailable" : "Page not found"}</h1>
        <p>{editorMode ? `Could not load draft content from orchestrator for ${slug}.` : `No content exists for ${slug}.`}</p>
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
