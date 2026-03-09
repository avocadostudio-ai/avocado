import { NextResponse } from "next/server"
import { getPublishedPage, getPublishedSlugs } from "../../../../lib/published-content-api"

export async function GET(request: Request) {
  const slugs = getPublishedSlugs()
  const pages = slugs
    .map((slug) => getPublishedPage(slug))
    .filter((page): page is NonNullable<typeof page> => page !== null)

  const origin = request.headers.get("origin") ?? "*"
  return NextResponse.json(
    { pages },
    {
      headers: {
        "cache-control": "no-store",
        "access-control-allow-origin": origin,
        vary: "Origin"
      }
    }
  )
}
