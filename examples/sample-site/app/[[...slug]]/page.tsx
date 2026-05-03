import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getSamplePage, getSampleSlugs, getSampleSiteConfig } from "../../lib/pages"

const { Page, generateStaticParams } = createSitePage({
  mode: "static",
  siteId: "sample-site",
  getPage: getSamplePage,
  getSlugs: getSampleSlugs,
  getSiteConfig: getSampleSiteConfig,
  // Sample pages embed their own SiteHeader/Footer blocks, so disable
  // the auto-generated chrome from createSitePage.
  chrome: false,
})

export default Page
export { generateStaticParams }
