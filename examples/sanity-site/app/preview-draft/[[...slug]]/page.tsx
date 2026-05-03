import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getSanityPage, getSanitySlugs, getSanitySiteConfig } from "../../../lib/sanity.fetch"

export const dynamic = "force-dynamic"

const { Page } = createSitePage({
  mode: "preview",
  siteId: "sanity-site",
  getPage: getSanityPage,
  getSlugs: getSanitySlugs,
  getSiteConfig: getSanitySiteConfig,
  footer: {
    id: "chrome_footer",
    type: "Footer",
    props: {
      copyright: `© ${new Date().getFullYear()} Sanity Site. All rights reserved.`,
      columns: [
        { title: "Product", links: "Home|/" },
        { title: "Resources", links: "Sanity|https://www.sanity.io" },
      ],
    },
  },
})

export default Page
