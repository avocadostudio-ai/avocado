import { NextResponse, type NextRequest } from "next/server"

/**
 * Options for the editor middleware factory.
 */
export type EditorMiddlewareOptions = {
  /**
   * The internal route prefix that the dynamic editor/draft page lives under.
   * @default "/preview-draft"
   */
  previewRoute?: string

  /**
   * Query parameter that signals an editor iframe request.
   * @default "__editor"
   */
  editorParam?: string

  /**
   * Name of the Next.js draft-mode bypass cookie.
   * @default "__prerender_bypass"
   */
  draftCookie?: string
}

/**
 * Create a Next.js middleware function that rewrites editor/draft requests
 * to a dynamic preview route, keeping the main page route fully static.
 *
 * Usage in `middleware.ts`:
 * ```ts
 * import { createEditorMiddleware } from "@ai-site-editor/site-sdk/middleware"
 * export const { middleware, config } = createEditorMiddleware()
 * ```
 */
export function createEditorMiddleware(options?: EditorMiddlewareOptions) {
  const previewRoute = options?.previewRoute ?? "/preview-draft"
  const editorParam = options?.editorParam ?? "__editor"
  const draftCookie = options?.draftCookie ?? "__prerender_bypass"

  function middleware(request: NextRequest) {
    const isEditor = request.nextUrl.searchParams.get(editorParam) === "1"
    const hasDraftCookie = request.cookies.has(draftCookie)

    if (isEditor || hasDraftCookie) {
      const url = request.nextUrl.clone()
      url.pathname = `${previewRoute}${url.pathname}`
      return NextResponse.rewrite(url)
    }

    return NextResponse.next()
  }

  // Escape special regex chars in the route prefix (strip leading slash for the pattern)
  const escapedRoute = previewRoute.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  const config = {
    matcher: [
      `/((?!_next|${escapedRoute}|api|favicon\\.ico|icon\\.svg|logos/|generated-images/|.*\\.).*)`
    ],
  }

  return { middleware, config }
}
