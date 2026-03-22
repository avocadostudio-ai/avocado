import { revalidatePath } from "next/cache"
import { getStrapiPages } from "../../../lib/strapi.fetch"

/**
 * Strapi webhook handler for on-demand ISR revalidation.
 *
 * Configure in Strapi:
 *   Settings → Webhooks → Add new webhook
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Events: Entry → create, update, delete, publish, unpublish
 *   Headers: x-revalidate-secret = <your secret>
 */
export async function POST(request: Request) {
  const configuredSecret = process.env.STRAPI_WEBHOOK_SECRET?.trim()
  if (!configuredSecret) {
    return Response.json({ error: "STRAPI_WEBHOOK_SECRET not configured" }, { status: 500 })
  }
  const provided = request.headers.get("x-revalidate-secret")?.trim()
  if (!provided || provided !== configuredSecret) {
    return Response.json({ error: "Invalid secret" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as {
      model?: string
      entry?: { slug?: string }
    }

    // Revalidate the specific page if slug is available, otherwise revalidate all
    const slug = body?.entry?.slug ?? "/"
    const path = slug === "/" ? "/" : `/${slug.replace(/^\//, "")}`
    revalidatePath(path)

    // Re-bootstrap orchestrator with fresh Strapi content
    const orchestratorUrl = process.env.ORCHESTRATOR_URL
    if (orchestratorUrl) {
      const pages = await getStrapiPages()
      await fetch(`${orchestratorUrl}/draft/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: "dev",
          siteId: "strapi-site",
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
