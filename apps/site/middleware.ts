import { NextResponse, type NextRequest } from "next/server"

/**
 * Middleware that rewrites editor/draft requests to the dynamic `/preview-draft` route.
 *
 * The main `[[...slug]]` route is fully static (no draftMode/searchParams access).
 * Editor iframe requests (with `__editor=1` query param or a Next.js draft-mode
 * cookie) are transparently rewritten to `/preview-draft/...` which is force-dynamic
 * and fetches draft content from the orchestrator.
 */
export function middleware(request: NextRequest) {
  const isEditor = request.nextUrl.searchParams.get("__editor") === "1"
  const hasDraftCookie = request.cookies.has("__prerender_bypass")

  if (isEditor || hasDraftCookie) {
    const url = request.nextUrl.clone()
    url.pathname = `/preview-draft${url.pathname}`
    return NextResponse.rewrite(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match all page routes except:
     * - /_next (Next.js internals)
     * - /preview-draft (already rewritten)
     * - /api (API routes)
     * - Static files (favicon, images, etc.)
     */
    "/((?!_next|preview-draft|api|favicon\\.ico|icon\\.svg|logos/|generated-images/|.*\\.).*)",
  ],
}
