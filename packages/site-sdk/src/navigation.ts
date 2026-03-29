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
  href?: string
  label: string
  isActive: boolean
  children?: NavItem[]
}

type NavLinkProp = { label: string; href?: string; children?: NavLinkProp[] }

export type SiteHeaderBlock = {
  id: string
  type: "SiteHeader"
  props: {
    siteName: string
    logoUrl: string
    links: NavLinkProp[]
    activePath?: string
  }
}

function mapNavItemToLink(item: NavItem): NavLinkProp {
  const link: NavLinkProp = { label: item.label }
  if (item.href) link.href = item.href
  if (item.children?.length) link.children = item.children.map(mapNavItemToLink)
  return link
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
      links: opts.navItems.map(mapNavItemToLink),
      activePath: opts.activePath,
    },
  }
}

export function buildNavItems(opts: {
  navSlugs: string[]
  currentSlug: string
  siteConfig: { name?: string; logo?: string; navLabels?: Record<string, string>; navGroups?: Record<string, string[]> }
  siteId: string
  editorQuery: string
  defaultLogo?: string
}): { navItems: NavItem[]; siteName: string; siteLogo: string; homeHref: string } {
  const { navSlugs, currentSlug, siteConfig, siteId, editorQuery } = opts

  const siteName = siteConfig.name || siteNameFallback(siteId) || "Site"
  const siteLogo = siteConfig.logo || opts.defaultLogo || ""

  const allSlugs = Array.from(
    new Set([...(navSlugs.length > 0 ? navSlugs : ["/"]), currentSlug])
  )
  const orderedSlugs = allSlugs.includes("/")
    ? ["/", ...allSlugs.filter((r) => r !== "/")]
    : allSlugs

  // Build flat items first
  const flatItems = orderedSlugs.map((route) => ({
    href: `${route}${editorQuery}`,
    label: siteConfig.navLabels?.[route] ?? slugToLabel(route),
    isActive: route === currentSlug,
    _slug: route, // internal, stripped before return
  }))

  // Apply navGroups to collapse slugs into parent dropdown items
  const navGroups = siteConfig.navGroups
  let navItems: NavItem[]

  if (navGroups && Object.keys(navGroups).length > 0) {
    // Build reverse lookup: slug → group label
    const slugToGroup = new Map<string, string>()
    for (const [groupLabel, slugs] of Object.entries(navGroups)) {
      for (const slug of slugs) slugToGroup.set(slug, groupLabel)
    }

    const emittedGroups = new Set<string>()
    navItems = []

    for (const item of flatItems) {
      const groupLabel = slugToGroup.get(item._slug)
      if (groupLabel) {
        if (emittedGroups.has(groupLabel)) continue // already emitted as part of parent
        emittedGroups.add(groupLabel)

        // Collect all children in this group (preserving order from navGroups definition)
        const groupSlugs = navGroups[groupLabel]
        const children: NavItem[] = groupSlugs
          .map((slug) => flatItems.find((fi) => fi._slug === slug))
          .filter((fi): fi is typeof flatItems[number] => !!fi)
          .map(({ _slug: _, ...rest }) => rest)

        navItems.push({
          label: groupLabel,
          isActive: children.some((c) => c.isActive),
          children,
        })
      } else {
        const { _slug: _, ...rest } = item
        navItems.push(rest)
      }
    }
  } else {
    navItems = flatItems.map(({ _slug: _, ...rest }) => rest)
  }

  const homeHref = `/${editorQuery}`

  return { navItems, siteName, siteLogo, homeHref }
}
