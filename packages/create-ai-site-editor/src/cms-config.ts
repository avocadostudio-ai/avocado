import type { CmsChoice } from "./types.js"

export type CmsDescriptor = {
  /** Import statement for the publish handler */
  publishImport: string
  /** Import statement for getPages */
  getPagesImport: string
  /** Expression for onPublish in createEditorApiHandler */
  onPublish: string
  /** Expression for getPages in createEditorApiHandler */
  getPages: string
  /** Import for page component (getPage, getSlugs, getSiteConfig) */
  pageImport: string
  /** Function names for createSitePage */
  getPage: string
  getSlugs: string
  getSiteConfig: string | null
  /** Revalidation config */
  revalidate: {
    secretEnvVar: string
    secretHeader: string | null
    extractSlug: string
    getPagesImport: string
    getPagesFn: string
  } | null
  /** Env var template */
  envVars: string
  /** Additional npm dependencies */
  npmDeps: string
  /** Additional next.config image hostname */
  imageHostname: string | null
  /** Additional next.config compiler options */
  compilerConfig: string
}

export const CMS_CONFIGS: Record<CmsChoice, CmsDescriptor> = {
  sanity: {
    publishImport: `import { createSanityPublishHandler } from "../../../../lib/publish"`,
    getPagesImport: `import { getSanityPages } from "../../../../lib/sanity.fetch"`,
    onPublish: `createSanityPublishHandler()`,
    getPages: `() => getSanityPages()`,
    pageImport: `import { getSanityPage, getSanitySlugs, getSanitySiteConfig } from "../../lib/sanity.fetch"`,
    getPage: "getSanityPage",
    getSlugs: "getSanitySlugs",
    getSiteConfig: "getSanitySiteConfig",
    revalidate: {
      secretEnvVar: "SANITY_WEBHOOK_SECRET",
      secretHeader: `["query:secret", "x-sanity-webhook-secret"]`,
      extractSlug: `(body) => (body as { slug?: { current?: string } })?.slug?.current ?? null`,
      getPagesImport: `import { getSanityPages } from "../../../lib/sanity.fetch"`,
      getPagesFn: "getSanityPages",
    },
    envVars: `# Sanity
NEXT_PUBLIC_SANITY_PROJECT_ID=
NEXT_PUBLIC_SANITY_DATASET=production
SANITY_API_TOKEN=
SANITY_WEBHOOK_SECRET=`,
    npmDeps: " @sanity/client @sanity/image-url groq",
    imageHostname: "cdn.sanity.io",
    compilerConfig: `  compiler: { styledComponents: true },\n`,
  },

  contentful: {
    publishImport: `import { createContentfulPublishHandler } from "../../../../lib/publish"`,
    getPagesImport: `import { getContentfulPages } from "../../../../lib/contentful"`,
    onPublish: `createContentfulPublishHandler({
    spaceId: process.env.CONTENTFUL_SPACE_ID!,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN!,
    environmentId: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  })`,
    getPages: `() => getContentfulPages()`,
    pageImport: `import { getContentfulPage, getContentfulSlugs, getContentfulSiteConfig } from "../../lib/contentful"`,
    getPage: "getContentfulPage",
    getSlugs: "getContentfulSlugs",
    getSiteConfig: "getContentfulSiteConfig",
    revalidate: {
      secretEnvVar: "REVALIDATION_SECRET",
      secretHeader: null,
      extractSlug: `(body) =>\n    (body as { fields?: { slug?: { "en-US"?: string } } })?.fields?.slug?.["en-US"] ?? null`,
      getPagesImport: `import { getContentfulPages } from "../../../lib/contentful"`,
      getPagesFn: "getContentfulPages",
    },
    envVars: `# Contentful
CONTENTFUL_SPACE_ID=
CONTENTFUL_ENVIRONMENT=master
CONTENTFUL_DELIVERY_TOKEN=
CONTENTFUL_MANAGEMENT_TOKEN=
REVALIDATION_SECRET=`,
    npmDeps: " contentful contentful-management",
    imageHostname: "images.ctfassets.net",
    compilerConfig: "",
  },

  strapi: {
    publishImport: `import { createStrapiPublishHandler } from "../../../../lib/publish"`,
    getPagesImport: `import { getStrapiPages } from "../../../../lib/strapi.fetch"`,
    onPublish: `createStrapiPublishHandler()`,
    getPages: `() => getStrapiPages()`,
    pageImport: `import { getStrapiPage, getStrapiSlugs, getStrapiSiteConfig } from "../../lib/strapi.fetch"`,
    getPage: "getStrapiPage",
    getSlugs: "getStrapiSlugs",
    getSiteConfig: "getStrapiSiteConfig",
    revalidate: {
      secretEnvVar: "STRAPI_WEBHOOK_SECRET",
      secretHeader: null,
      extractSlug: `(body) =>\n    (body as { entry?: { slug?: string } })?.entry?.slug ?? null`,
      getPagesImport: `import { getStrapiPages } from "../../../lib/strapi.fetch"`,
      getPagesFn: "getStrapiPages",
    },
    envVars: `# Strapi
STRAPI_URL=http://localhost:1337
STRAPI_API_TOKEN=
STRAPI_WEBHOOK_SECRET=`,
    npmDeps: "",
    imageHostname: null,
    compilerConfig: "",
  },

  none: {
    publishImport: `import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { resolve } from "node:path"`,
    getPagesImport: "",
    onPublish: `createJsonFilePublishHandler(resolve(process.cwd(), "content/pages.json"))`,
    getPages: `() => Promise.resolve([])`,
    pageImport: `import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { PageDoc } from "@ai-site-editor/shared"`,
    getPage: "",
    getSlugs: "",
    getSiteConfig: null,
    revalidate: null,
    envVars: "",
    npmDeps: "",
    imageHostname: null,
    compilerConfig: "",
  },
}
