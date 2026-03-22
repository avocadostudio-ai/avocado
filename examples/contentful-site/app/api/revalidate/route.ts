import { revalidatePath } from "next/cache"

/**
 * Contentful webhook handler for on-demand ISR revalidation.
 *
 * Configure in Contentful:
 *   URL: https://your-site.vercel.app/api/revalidate
 *   Method: POST
 *   Headers: x-revalidate-secret = <your secret>
 *   Triggers: Entry publish, Entry unpublish (content type: page)
 */
export async function POST(request: Request) {
  const secret = request.headers.get("x-revalidate-secret")
  if (secret !== process.env.REVALIDATION_SECRET) {
    return Response.json({ error: "Invalid secret" }, { status: 401 })
  }

  try {
    const body = (await request.json()) as {
      fields?: { slug?: { "en-US"?: string } }
    }
    const slug = body?.fields?.slug?.["en-US"] ?? "/"
    const path = slug === "/" ? "/" : `/${slug.replace(/^\//, "")}`

    revalidatePath(path)

    return Response.json({ revalidated: true, path })
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 })
  }
}
