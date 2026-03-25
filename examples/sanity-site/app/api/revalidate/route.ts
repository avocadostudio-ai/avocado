import { createRevalidateHandler } from "@ai-site-editor/site-sdk/routes"
import { getSanityPages } from "../../../lib/sanity.fetch"

/**
 * Sanity webhook handler for on-demand ISR revalidation.
 *
 * Configure in Sanity:
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Method: POST
 *   Secret: <SANITY_WEBHOOK_SECRET> (in query param "secret")
 *   Filter: _type == "page"
 */
export const POST = createRevalidateHandler({
  secretEnvVar: "SANITY_WEBHOOK_SECRET",
  secretHeader: ["query:secret", "x-sanity-webhook-secret"], // Sanity sends secret as query param or header
  extractSlug: (body) => (body as { slug?: { current?: string } })?.slug?.current ?? null,
  getPages: getSanityPages,
  siteId: "sanity-site",
})
