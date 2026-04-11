import { createRevalidateHandler } from "@ai-site-editor/site-sdk/routes"
import { getContentfulPages } from "@/lib/contentful"

export const POST = createRevalidateHandler({
  secretEnvVar: "REVALIDATION_SECRET",
  extractSlug: (body) =>
    (body as { fields?: { slug?: { "en-US"?: string } } })?.fields?.slug?.["en-US"] ?? null,
  getPages: getContentfulPages,
  siteId: "contentful-marketing-site",
})
