import { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"
import { createBlocksHandler, createPagesHandler } from "./editor-routes.ts"
import { applyEditorCors } from "./editor-cors.ts"
import type { BlockManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"

export interface EditorApiHandlerConfig {
  getPages: () => PageDoc[]
  getManifest?: () => BlockManifest
}

type NextRouteContext = { params: Promise<{ path: string[] }> }

/**
 * Creates a single catch-all route handler that serves all editor API endpoints.
 *
 * Mount at `app/api/editor/[...path]/route.ts`:
 * ```ts
 * export const { GET, OPTIONS } = createEditorApiHandler({ getPages: () => [...] })
 * ```
 *
 * Routes:
 * - `/api/editor/draft` → enable draft mode
 * - `/api/editor/draft/disable` → disable draft mode
 * - `/api/editor/blocks` → block manifest
 * - `/api/editor/pages` → published pages
 */
export function createEditorApiHandler(config: EditorApiHandlerConfig): {
  GET: (request: Request, context: NextRouteContext) => Promise<Response>
  OPTIONS: (request: Request, context: NextRouteContext) => Response
} {
  const draftEnable = createDraftEnableHandler()
  const draftDisable = createDraftDisableHandler()
  const blocksHandler = createBlocksHandler(config.getManifest ? { getManifest: config.getManifest } : undefined)
  const pagesHandler = createPagesHandler(config.getPages)

  function matchRoute(path: string[]): string {
    const key = path.join("/")
    if (key === "draft") return "draft-enable"
    if (key === "draft/disable") return "draft-disable"
    if (key === "blocks") return "blocks"
    if (key === "pages") return "pages"
    return "not-found"
  }

  return {
    async GET(request: Request, context: NextRouteContext) {
      const { path } = await context.params
      const route = matchRoute(path)

      switch (route) {
        case "draft-enable":
          return draftEnable(request)
        case "draft-disable":
          return draftDisable(request)
        case "blocks":
          return blocksHandler.GET(request)
        case "pages":
          return pagesHandler.GET(request)
        default:
          return applyEditorCors(
            new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }),
            request.headers.get("origin")
          )
      }
    },

    OPTIONS(request: Request, context: NextRouteContext) {
      // OPTIONS doesn't need async params resolution for CORS preflight
      return blocksHandler.OPTIONS(request)
    },
  }
}
