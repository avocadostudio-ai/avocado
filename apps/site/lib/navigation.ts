export function siteNameFallback(siteId: string) {
  return siteId
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ")
}

export function slugToLabel(route: string) {
  if (route === "/") return "Home"
  return route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
}

export type NavItem = {
  href: string
  label: string
  isActive: boolean
}

export type SiteHeaderBlock = {
  id: string
  type: "SiteHeader"
  props: {
    siteName: string
    logoUrl: string
    links: { label: string; href: string }[]
    activePath?: string
  }
}

export function buildSiteHeaderBlock(opts: {
  navItems: NavItem[]
  siteName: string
  siteLogo: string
  activePath: string
}): SiteHeaderBlock {
  return {
    id: "chrome_site-header",
    type: "SiteHeader",
    props: {
      siteName: opts.siteName,
      logoUrl: opts.siteLogo,
      links: opts.navItems.map((item) => ({ label: item.label, href: item.href })),
      activePath: opts.activePath,
    },
  }
}

export function buildNavItems(opts: {
  navSlugs: string[]
  currentSlug: string
  siteConfig: { name?: string; logo?: string; navLabels?: Record<string, string> }
  siteId: string
  editorQuery: string
}): { navItems: NavItem[]; siteName: string; siteLogo: string; homeHref: string } {
  const { navSlugs, currentSlug, siteConfig, siteId, editorQuery } = opts

  const siteName = siteConfig.name || siteNameFallback(siteId) || "Site"
  const siteLogo = siteConfig.logo || "/logos/default.svg"

  const allSlugs = Array.from(
    new Set([...(navSlugs.length > 0 ? navSlugs : ["/", "/pricing"]), currentSlug])
  )
  const orderedSlugs = allSlugs.includes("/")
    ? ["/", ...allSlugs.filter((r) => r !== "/")]
    : allSlugs

  const navItems = orderedSlugs.map((route) => ({
    href: `${route}${editorQuery}`,
    label: siteConfig.navLabels?.[route] ?? slugToLabel(route),
    isActive: route === currentSlug,
  }))

  const homeHref = `/${editorQuery}`

  return { navItems, siteName, siteLogo, homeHref }
}
