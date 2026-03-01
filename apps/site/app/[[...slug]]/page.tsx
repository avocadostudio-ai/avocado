import Link from "next/link"
import { unstable_noStore as noStore } from "next/cache"
import type { Metadata } from "next"
import "../site-nav.css"
import { BlockRenderer } from "../../components/block-renderer"
import { EditorPreviewBridge } from "../../components/editor-harness"
import { fetchDraftPage, fetchDraftSlugs, getPublishedSlugs } from "../../lib/content-api"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const DEFAULT_SESSION = "dev"
const DEFAULT_SITE_ID = "avocado-stories"
const DEFAULT_EDITOR_ORIGIN =
  process.env.NEXT_PUBLIC_EDITOR_ORIGIN ?? (process.env.NODE_ENV !== "production" ? "http://localhost:4100" : "")
const EDITOR_ENABLED = process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" || process.env.NODE_ENV !== "production"
export const dynamic = "force-dynamic"
export const revalidate = 0

function buildSlug(parts?: string[]) {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}

function getSingleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
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
  noStore()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)
  const editorMode = EDITOR_ENABLED && resolvedSearch.__editor === "1"
  const session = getSingleValue(resolvedSearch.session) ?? DEFAULT_SESSION
  const siteId = getSingleValue(resolvedSearch.siteId) ?? DEFAULT_SITE_ID

  const page = await fetchDraftPage(slug, session, siteId, editorMode)
  if (!page) return {}

  const meta: Metadata = {
    title: page.meta?.title ?? page.title
  }
  if (page.meta?.description) {
    meta.description = page.meta.description
  }
  if (page.meta?.ogImage) {
    meta.openGraph = { images: [page.meta.ogImage] }
  }
  return meta
}

export default async function SitePage({ params, searchParams }: PageProps) {
  noStore()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  const editorMode = EDITOR_ENABLED && resolvedSearch.__editor === "1"
  const tileMode = getSingleValue(resolvedSearch.__tile) === "1"
  const session = getSingleValue(resolvedSearch.session) ?? DEFAULT_SESSION
  const siteId = getSingleValue(resolvedSearch.siteId) ?? DEFAULT_SITE_ID
  const siteName = getSingleValue(resolvedSearch.siteName) ?? siteNameFromId(siteId) ?? "Site"
  const editorOrigin = getSingleValue(resolvedSearch.editorOrigin) ?? DEFAULT_EDITOR_ORIGIN

  const page = await fetchDraftPage(slug, session, siteId, editorMode)
  const fetchedSlugs = await fetchDraftSlugs(session, siteId, editorMode)
  const navRaw = Array.from(new Set([...(fetchedSlugs.length > 0 ? fetchedSlugs : ["/", "/pricing"]), slug]))
  const navSlugs = navRaw.includes("/") ? ["/", ...navRaw.filter((route) => route !== "/")] : navRaw
  const editorQuery = editorMode
      ? (() => {
        const params = new URLSearchParams({ __editor: "1", session, siteId })
        params.set("siteName", siteName)
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
          <span className="avocado-mark" aria-hidden="true">
            <span className="avocado-pit" />
          </span>
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
      </header>
      <main className={editorMode ? "editor-mode" : undefined}>
        {page.blocks.map((block) => (
          <BlockRenderer key={block.id} block={block} editorMode={editorMode} />
        ))}
      </main>
      {editorMode ? <EditorPreviewBridge slug={slug} editorOrigin={editorOrigin} /> : null}
    </>
  )
}
