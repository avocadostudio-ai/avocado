import { revalidatePath } from "next/cache"
import { getSanityPages } from "../../../lib/sanity.fetch"

/**
 * Sanity webhook handler for on-demand ISR revalidation.
 *
 * Configure in Sanity:
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Method: POST
 *   Secret: <SANITY_WEBHOOK_SECRET>
 *   Filter: _type == "page"
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.SANITY_WEBHOOK_SECRET?.trim()
  if (!configuredSecret) {
    return Response.json({ error: "SANITY_WEBHOOK_SECRET not configured" }, { status: 500 })
  }

  // Sanity sends the secret in the query string or a custom header
  const url = new URL(request.url)
  const provided = url.searchParams.get("secret")?.trim() ?? request.headers.get("x-sanity-webhook-secret")?.trim()
  if (!provided || provided !== configuredSecret) {
    return Response.json({ error: "Invalid secret" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as { slug?: { current?: string }; _type?: string }
    const slug = body?.slug?.current ?? "/"
    const path = slug === "/" ? "/" : `/${slug.replace(/^\//, "")}`

    revalidatePath(path)

    // Re-bootstrap orchestrator with fresh Sanity content
    const orchestratorUrl = process.env.ORCHESTRATOR_URL
    if (orchestratorUrl) {
      const pages = await getSanityPages()
      await fetch(`${orchestratorUrl}/draft/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: "dev",
          siteId: "sanity-site",
          pages,
          overwrite: true,
        }),
      }).catch(() => {})
    }

    return Response.json({ revalidated: true, path })
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }
}
