import { createRevalidateHandler } from "@ai-site-editor/site-sdk/routes"
import { getContentfulPages } from "../../../lib/contentful"

/**
 * Contentful webhook handler for on-demand ISR revalidation.
 *
 * Configure in Contentful:
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Method: POST
 *   Headers: x-revalidate-secret = <your secret>
 *   Triggers: Entry publish, Entry unpublish (content type: page)
 */
export const POST = createRevalidateHandler({
  secretEnvVar: "REVALIDATION_SECRET",
  extractSlug: (body) =>
    (body as { fields?: { slug?: { "en-US"?: string } } })?.fields?.slug?.["en-US"] ?? null,
  getPages: getContentfulPages,
  siteId: "contentful-site",
})
