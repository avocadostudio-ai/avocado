import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getStrapiPage, getStrapiSlugs, getStrapiSiteConfig } from "../../../lib/strapi.fetch"

export const dynamic = "force-dynamic"

const { Page } = createSitePage({
  mode: "preview",
  siteId: "strapi-site",
  getPage: getStrapiPage,
  getSlugs: getStrapiSlugs,
  getSiteConfig: getStrapiSiteConfig,
  footer: {
    id: "chrome_footer",
    type: "Footer",
    props: {
      copyright: `© ${new Date().getFullYear()} Strapi Site. All rights reserved.`,
      columns: [
        { title: "Product", links: "Home|/" },
        { title: "Resources", links: "Strapi|https://strapi.io" },
      ],
    },
  },
})

export default Page
