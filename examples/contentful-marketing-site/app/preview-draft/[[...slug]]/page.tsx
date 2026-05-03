import { createSitePage } from "@ai-site-editor/site-sdk/page"
import {
  getContentfulPage,
  getContentfulSiteConfig,
  getContentfulSlugs,
} from "@/lib/contentful"

import "@/src/blocks/register"

export const dynamic = "force-dynamic"

const { Page } = createSitePage({
  mode: "preview",
  siteId: "contentful-marketing-site",
  getPage: getContentfulPage,
  getSlugs: getContentfulSlugs,
  getSiteConfig: getContentfulSiteConfig,
  chrome: true,
})

export default Page
