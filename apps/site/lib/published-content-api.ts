import { pageDocSchema, type PageDoc } from "./site-contract.ts"
import type { SiteConfig } from "@ai-site-editor/shared"
import publishedContent from "./published-content.json" with { type: "json" }

function loadPublishedData(): { pages: PageDoc[]; siteConfig: SiteConfig } {
  // Support both legacy array format and new { pages, siteConfig } format
  const raw = publishedContent as unknown
  const candidates = Array.isArray(raw) ? raw : (raw as { pages?: unknown }).pages
  const pages: PageDoc[] = []
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const parsed = pageDocSchema.safeParse(candidate)
      if (parsed.success) pages.push(parsed.data)
    }
  }
  const siteConfig = (!Array.isArray(raw) && raw && typeof raw === "object" && "siteConfig" in raw)
    ? (raw as { siteConfig: SiteConfig }).siteConfig ?? {}
    : {}
  return { pages, siteConfig }
}

const publishedData = loadPublishedData()
const publishedPagesBySlug = new Map(publishedData.pages.map((page) => [page.slug, page] as const))
const publishedSlugs = publishedData.pages.map((page) => page.slug)

export function getPublishedSlugs() {
  return [...publishedSlugs]
}

export function getPublishedPage(slug: string): PageDoc | null {
  const page = publishedPagesBySlug.get(slug)
  return page ? structuredClone(page) : null
}

export function getPublishedSiteConfig(): SiteConfig {
  return { ...publishedData.siteConfig }
}
