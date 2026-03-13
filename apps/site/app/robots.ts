import type { MetadataRoute } from "next"
import { getPublishedSlugs } from "../lib/published-content-api"

function getSiteUrl() {
  const fallback = "http://localhost:3000"
  const value = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!value) return fallback
  return value.replace(/\/+$/, "")
}

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl()
  const slugs = getPublishedSlugs()

  return {
    rules: {
      userAgent: "*",
      allow: slugs,
      disallow: ["/api/", "/*?*__editor=*", "/*?*session=*", "/*?*siteId=*"]
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl
  }
}
