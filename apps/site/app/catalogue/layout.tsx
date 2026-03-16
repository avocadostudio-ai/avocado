import { notFound } from "next/navigation"
import type { ReactNode } from "react"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { getPublishedSlugs, getPublishedSiteConfig } from "../../lib/published-content-api"
import { buildNavItems, buildSiteHeaderBlock } from "../../lib/navigation"

const CATALOGUE_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_EDITOR === "1" ||
  process.env.NODE_ENV !== "production"

export default function CatalogueLayout({ children }: { children: ReactNode }) {
  if (!CATALOGUE_ENABLED) notFound()

  const siteConfig = getPublishedSiteConfig()
  const navSlugs = getPublishedSlugs()
  const { navItems, siteName, siteLogo } = buildNavItems({
    navSlugs,
    currentSlug: "/catalogue",
    siteConfig,
    siteId: "avocado-stories",
    editorQuery: "",
  })

  const chromeHeader = buildSiteHeaderBlock({ navItems, siteName, siteLogo, activePath: "/catalogue" })

  return (
    <>
      <SharedBlockRenderer block={chromeHeader} />
      {children}
    </>
  )
}
