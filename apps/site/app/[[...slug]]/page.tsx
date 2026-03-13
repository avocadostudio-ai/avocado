import Link from "next/link"
import { unstable_noStore as noStore } from "next/cache"
import { draftMode } from "next/headers"
import type { Metadata } from "next"
import "../site-nav.css"
import { BlockRenderer } from "../../components/block-renderer"
import { SiteThemeToggle } from "../../components/theme-toggle"

import { EditorPreviewBridgeLoader } from "../../components/editor-preview-bridge-loader"
import { fetchDraftPage } from "../../lib/content-api"
import { resolveSiteContentSource } from "../../lib/content-source"
import { resolveRuntimePageAndNav } from "../../lib/content-resolver-runtime"
import { getPublishedPage, getPublishedSlugs } from "../../lib/published-content-api"
import { derivePageDescription } from "../../lib/seo"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DEFAULT_SESSION = "dev"
const DEFAULT_SITE_ID = "avocado-stories"
const DEFAULT_EDITOR_ORIGIN = (process.env.NEXT_PUBLIC_EDITOR_ORIGIN ?? "").replace(/\/+$/, "")
const EDITOR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" || process.env.NODE_ENV !== "production"

function buildSlug(parts?: string[]) {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}

function getSingleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

function resolveContentSourceWithDevFallback({
  draftModeEnabled,
  search
}: {
  draftModeEnabled: boolean
  search: Record<string, string | string[] | undefined>
}) {
  if (draftModeEnabled) return resolveSiteContentSource({ draftModeEnabled: true })
  const devEditorFallback = process.env.NODE_ENV !== "production" && getSingleValue(search.__editor) === "1"
  return resolveSiteContentSource({ draftModeEnabled: devEditorFallback })
}

function slugToLabel(route: string) {
  if (route === "/") return "Home"
  return route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
}

function siteNameFromId(siteId: string) {
  return siteId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function siteLogoFromId(siteId: string) {
  const normalized = siteId.trim().toLowerCase()
  const available = new Set([
    "avocado-stories",
    "avocado-magic",
    "avocado-odyssey",
    "adventures-eg",
    "adventure-echo",
    "adventure-atlas",
    "trailbound-expeditions"
  ])
  if (available.has(normalized)) return `/logos/${normalized}.svg`
  return "/logos/default.svg"
}

export function generateStaticParams() {
  return getPublishedSlugs().map((slug) => ({
    slug:
      slug === "/"
        ? []
        : slug
            .slice(1)
            .split("/")
            .filter(Boolean)
  }))
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)
  const contentSource = resolveContentSourceWithDevFallback({ draftModeEnabled: draft.isEnabled, search: resolvedSearch })
  const session = getSingleValue(resolvedSearch.session) ?? DEFAULT_SESSION
  const siteId = getSingleValue(resolvedSearch.siteId) ?? DEFAULT_SITE_ID

  if (contentSource === "draft") noStore()
  const page =
    contentSource === "draft"
      ? await fetchDraftPage(slug, session, siteId, true)
      : getPublishedPage(slug)
  if (!page) return {}

  const description = derivePageDescription(page)
  const meta: Metadata = {
    title: page.meta?.title ?? page.title,
    description
  }
  meta.openGraph = { description }
  if (page.meta?.ogImage) {
    meta.openGraph.images = [page.meta.ogImage]
  }
  return meta
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const contentSource = resolveContentSourceWithDevFallback({ draftModeEnabled: draft.isEnabled, search: resolvedSearch })
  if (contentSource === "draft") noStore()
  const editorMode = EDITOR_ENABLED && contentSource === "draft"
  const tileMode = editorMode && getSingleValue(resolvedSearch.__tile) === "1"
  const session = getSingleValue(resolvedSearch.session) ?? DEFAULT_SESSION
  const siteId = getSingleValue(resolvedSearch.siteId) ?? DEFAULT_SITE_ID
  const siteName = siteNameFromId(siteId) || "Site"
  const editorOrigin = (getSingleValue(resolvedSearch.editorOrigin) ?? DEFAULT_EDITOR_ORIGIN).replace(/\/+$/, "")
  const siteLogo = siteLogoFromId(siteId)

  const { page, slugs: fetchedSlugs } = await resolveRuntimePageAndNav({
    source: contentSource,
    slug,
    session,
    siteId
  })
  const navRaw = Array.from(new Set([...(fetchedSlugs.length > 0 ? fetchedSlugs : ["/", "/pricing"]), slug]))
  const navSlugs = navRaw.includes("/") ? ["/", ...navRaw.filter((route) => route !== "/")] : navRaw
  const editorQuery = contentSource === "draft"
    ? (() => {
        const params = new URLSearchParams({ session, siteId })
        if (editorOrigin) params.set("editorOrigin", editorOrigin)
        return `?${params.toString()}`
      })()
    : ""

  if (!page) {
    if (editorMode) {
      return (
        <main>
          <h1>Draft unavailable</h1>
          <p>Could not load draft content from orchestrator for {slug}.</p>
        </main>
      )
    }
    return (
      <main>
        <h1>Page not found</h1>
        <p>No content exists for {slug}.</p>
      </main>
    )
  }

  return (
    <>
      {tileMode ? <style>{`nextjs-portal { display: none !important; }`}</style> : null}
      <header className="site-top-nav">
        <Link className="site-brand" href={`/${editorQuery}`}>
          <img className="site-logo" src={siteLogo} alt={`${siteName} logo`} width={38} height={38} />
          <span className="site-brand-text">{siteName}</span>
        </Link>
        <nav className="site-nav-links site-nav-links-desktop" aria-label="Primary">
          {navSlugs.map((route) => (
            <Link key={route} href={`${route}${editorQuery}`} className={route === slug ? "is-active" : undefined}>
              {slugToLabel(route)}
            </Link>
          ))}
        </nav>
        <details className="site-mobile-menu">
          <summary aria-label="Toggle navigation menu">
            <span className="burger-icon" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </summary>
          <nav className="site-nav-links site-nav-links-mobile" aria-label="Mobile primary">
            {navSlugs.map((route) => (
              <Link key={route} href={`${route}${editorQuery}`} className={route === slug ? "is-active" : undefined}>
                {slugToLabel(route)}
              </Link>
            ))}
          </nav>
        </details>
        <SiteThemeToggle />
      </header>
      <main className={editorMode ? "editor-mode" : undefined}>
        {page.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} editorMode={editorMode} />
        ))}
      </main>
      {editorMode && !tileMode ? <EditorPreviewBridgeLoader slug={slug} editorOrigin={editorOrigin} /> : null}
    </>
  )
}
