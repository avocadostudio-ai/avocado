import { createRevalidateHandler } from "@ai-site-editor/site-sdk/routes"
import { getStrapiPages } from "../../../lib/strapi.fetch"

/**
 * Strapi webhook handler for on-demand ISR revalidation.
 *
 * Configure in Strapi:
 *   Settings -> Webhooks -> Add new webhook
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Events: Entry -> create, update, delete, publish, unpublish
 *   Headers: x-revalidate-secret = <your secret>
 */
export const POST = createRevalidateHandler({
  secretEnvVar: "STRAPI_WEBHOOK_SECRET",
  extractSlug: (body) =>
    (body as { entry?: { slug?: string } })?.entry?.slug ?? null,
  getPages: getStrapiPages,
  siteId: "strapi-site",
})
