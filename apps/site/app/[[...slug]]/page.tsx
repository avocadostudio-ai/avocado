import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { buildSlug } from "@ai-site-editor/site-sdk"
import { SitePageContent } from "../../components/site-page-content"
import { getPublishedPage, getPublishedSlugs, getPublishedSiteConfig } from "../../lib/published-content-api"
import { derivePageDescription } from "../../lib/seo"
import { buildNavItems, buildSiteHeaderBlock } from "@ai-site-editor/site-sdk/navigation"
import { DEFAULT_SITE_ID } from "../../lib/defaults"
import { ThemeOverrides } from "../../components/theme-overrides"

type PageProps = {
  params: Promise<{ slug?: string[] }>
}

// --- Static generation ---

export function generateStaticParams() {
  return getPublishedSlugs().map((slug) => ({
    slug: slug === "/" ? [] : slug.slice(1).split("/").filter(Boolean)
  }))
}

// --- Metadata ---

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug: slugParts } = await params
  const slug = buildSlug(slugParts)
  const page = getPublishedPage(slug)
  if (!page) return {}

  const description = derivePageDescription(page)
  return {
    title: page.meta?.title ?? page.title,
    description,
    openGraph: { description, ...(page.meta?.ogImage ? { images: [page.meta.ogImage] } : {}) }
  }
}

// --- Page ---

export default async function SitePage({ params }: PageProps) {
  const { slug: slugParts } = await params
  const slug = buildSlug(slugParts)

  const page = getPublishedPage(slug)
  if (!page) notFound()

  const siteConfig = getPublishedSiteConfig()
  const navSlugs = getPublishedSlugs()

  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: slug,
    siteConfig,
    siteId: DEFAULT_SITE_ID,
    editorQuery: ""
  })

  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: slug })

  return (
    <>
      <ThemeOverrides siteConfig={siteConfig} />
      <SitePageContent page={page} chromeHeader={chromeHeader} />
    </>
  )
}
