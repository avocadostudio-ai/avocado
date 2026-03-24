import { z } from "zod"
import { registerBlock } from "./_registry.ts"
import { f } from "./_helpers.ts"

const navLinkLeaf = z.object({
  label: z.string().min(1),
  href: z.string().min(1),
})

registerBlock("SiteHeader", {
  schema: z.object({
    siteName: z.string().min(1),
    logoUrl: z.string().min(1),
    links: z.array(navLinkLeaf.extend({
      href: z.string().optional(),         // parent dropdown items have no href
      children: z.array(navLinkLeaf).optional(), // 2nd-level dropdown items
    })).min(1),
  }),
  meta: {
    displayName: "Site Header",
    description: "Global site navigation bar with logo, site name, and nav links.",
    category: "navigation",
    chrome: true,
    fields: {
      siteName: f.text("Site name"),
      logoUrl: f.image("Logo"),
    },
    listFields: {
      links: {
        label: "Nav links",
        itemFields: {
          label: f.text("Link label"),
          href: f.url("Link URL"),
        },
      },
    },
  },
})

export function siteHeaderDefaultProps(): Record<string, unknown> {
  return {
    siteName: "My Site",
    logoUrl: "/logos/default.svg",
    links: [
      { label: "Home", href: "/" },
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
    ],
  }
}
