import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getSamplePage, getSampleSlugs, getSampleSiteConfig } from "../../../lib/pages"

export const dynamic = "force-dynamic"

const { Page } = createSitePage({
  mode: "preview",
  siteId: "sample-site",
  getPage: getSamplePage,
  getSlugs: getSampleSlugs,
  getSiteConfig: getSampleSiteConfig,
  chrome: false,
})

export default Page
