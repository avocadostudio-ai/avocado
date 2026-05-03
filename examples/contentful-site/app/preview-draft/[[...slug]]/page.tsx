import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getContentfulPage, getContentfulSlugs, getContentfulSiteConfig } from "../../../lib/contentful"

export const dynamic = "force-dynamic"

const { Page } = createSitePage({
  mode: "preview",
  siteId: "contentful-site",
  getPage: getContentfulPage,
  getSlugs: getContentfulSlugs,
  getSiteConfig: getContentfulSiteConfig,
  footer: {
    id: "chrome_footer",
    type: "Footer",
    props: {
      copyright: `© ${new Date().getFullYear()} Contentful Site. All rights reserved.`,
      columns: [
        { title: "Product", links: "Home|/" },
        { title: "Resources", links: "Contentful|https://www.contentful.com" },
      ],
    },
  },
})

export default Page
