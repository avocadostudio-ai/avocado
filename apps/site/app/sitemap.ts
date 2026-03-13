import type { MetadataRoute } from "next"
import { getPublishedPage, getPublishedSlugs } from "../lib/published-content-api"

function getSiteUrl() {
  const fallback = "http://localhost:3000"
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!value) return fallback
  return value.replace(/\/+$/, "")
}

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl()
  return getPublishedSlugs().map((slug) => {
    const page = getPublishedPage(slug)
    const url = slug === "/" ? siteUrl : `${siteUrl}${slug}`
    const lastModified = page?.updatedAt ? new Date(page.updatedAt) : undefined
    return {
      url,
      lastModified
    }
  })
}
