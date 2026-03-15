import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import type { Metadata } from "next"
import { resolveDraftContext, isTileMode, single, buildSlug, TileModeStyles, EditorOverlay, getPreviewWrapperProps, BlockErrorBoundary } from "@ai-site-editor/site-sdk"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import "../site-nav.css"
import { SiteHeader } from "../../components/site-header"
import { resolveContentSource, getPage, getNavSlugs } from "../../lib/content"
import { getPublishedPage, getPublishedSlugs } from "../../lib/published-content-api"
import { derivePageDescription } from "../../lib/seo"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const EDITOR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" || process.env.NODE_ENV !== "production"

// --- Site-specific presentation helpers ---

const SITE_DISPLAY_OVERRIDES: Record<string, { name?: string; logo?: string }> = {
  "adventure-atlas": { name: "Avocado Stories", logo: "/logos/avocado-stories.svg" }
}

function siteNameFromId(siteId: string) {
  const override = SITE_DISPLAY_OVERRIDES[siteId.trim().toLowerCase()]
  if (override?.name) return override.name
  return siteId.split("-").filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")
}

function siteLogoFromId(siteId: string) {
  const normalized = siteId.trim().toLowerCase()
  const override = SITE_DISPLAY_OVERRIDES[normalized]
  if (override?.logo) return override.logo
  const available = new Set(["avocado-stories", "avocado-magic", "avocado-odyssey", "adventures-eg", "adventure-echo", "adventure-atlas", "trailbound-expeditions"])
  if (available.has(normalized)) return `/logos/${normalized}.svg`
  return "/logos/default.svg"
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

  // Editor integration: resolve draft context from SDK
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
  const tileMode = editorMode && isTileMode(resolvedSearch)
  const session = editorCtx?.session ?? "dev"
  const siteId = editorCtx?.siteId ?? "avocado-stories"
  const editorOrigin = editorCtx?.editorOrigin ?? ""

  // Fetch content
  const [page, navSlugs] = await Promise.all([
    getPage(slug, contentSource, session, siteId),
    getNavSlugs(contentSource, session, siteId)
  ])

  // Build navigation
  const siteName = siteNameFromId(siteId) || "Site"
  const siteLogo = siteLogoFromId(siteId)
  const allSlugs = Array.from(new Set([...(navSlugs.length > 0 ? navSlugs : ["/", "/pricing"]), slug]))
  const orderedSlugs = allSlugs.includes("/") ? ["/", ...allSlugs.filter((r) => r !== "/")] : allSlugs
  const editorQuery = editorMode
    ? (() => {
        const p = new URLSearchParams({ session, siteId })
        if (editorOrigin) p.set("editorOrigin", editorOrigin)
        return `?${p.toString()}`
      })()
    : ""
  const navItems = orderedSlugs.map((route) => ({
    href: `${route}${editorQuery}`,
    label: slugToLabel(route),
    isActive: route === slug
  }))

  if (!page) {
    return (
      <main>
        <h1>{editorMode ? "Draft unavailable" : "Page not found"}</h1>
        <p>{editorMode ? `Could not load draft content from orchestrator for ${slug}.` : `No content exists for ${slug}.`}</p>
      </main>
    )
  }

  return (
    <>
      {tileMode && <TileModeStyles />}
      <SiteHeader siteName={siteName} siteLogo={siteLogo} homeHref={`/${editorQuery}`} navItems={navItems} />
      <main className={editorMode ? "editor-mode" : undefined}>
        {page.blocks.map((block) => (
          <div key={block.id} {...getPreviewWrapperProps(editorMode, block.id, block.type)}>
            <BlockErrorBoundary blockId={block.id} blockType={block.type}>
              <SharedBlockRenderer block={block} />
            </BlockErrorBoundary>
          </div>
        ))}
      </main>
      {editorMode && !tileMode && <EditorOverlay slug={slug} editorOrigin={editorOrigin} />}
    </>
  )
}
