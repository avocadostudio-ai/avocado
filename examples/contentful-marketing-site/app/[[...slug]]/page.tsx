import { createSitePage } from "@ai-site-editor/site-sdk/page"
import {
  getContentfulPage,
  getContentfulPages,
  getContentfulSiteConfig,
  getContentfulSlugs,
} from "@/lib/contentful"

// Ensure custom blocks are registered before the page renders. The
// root layout also imports this, but Next.js can evaluate page modules
// in isolation during static generation, so we import here too.
import "@/src/blocks/register"

void getContentfulPages // keep tree-shaking honest; referenced by editor API

const { Page, generateStaticParams } = createSitePage({
  mode: "static",
  siteId: "contentful-marketing-site",
  getPage: getContentfulPage,
  getSlugs: getContentfulSlugs,
  getSiteConfig: getContentfulSiteConfig,
  chrome: true,
})

export default Page
export { generateStaticParams }
