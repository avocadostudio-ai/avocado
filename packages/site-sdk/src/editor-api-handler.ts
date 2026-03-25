import { createDraftEnableHandler, createDraftDisableHandler } from "./draft-routes.ts"
import { createBlocksHandler, createPagesHandler, createPublishHandler } from "./editor-routes.ts"
import type { OnPublishFn } from "./editor-routes.ts"
import { applyEditorCors } from "./editor-cors.ts"
import { checkIntegrationOnce } from "./integration-check.ts"
import type { BlockManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"

export interface EditorApiHandlerConfig {
  getPages: () => PageDoc[] | Promise<PageDoc[]>
  getManifest?: () => BlockManifest
  onPublish?: OnPublishFn
  /** Secret token required for publish requests. Checked against x-publish-token header. */
  publishSecret?: string
}

type NextRouteContext = { params: Promise<{ path: string[] }> }

/**
 * Creates a single catch-all route handler that serves all editor API endpoints.
 *
 * Mount at `app/api/editor/[...path]/route.ts`:
 * ```ts
 * export const { GET, POST, OPTIONS } = createEditorApiHandler({
 *   getPages: () => [...],
 *   onPublish: async (pages, config) => { ... return { ok: true } }
 * })
 * ```
 *
 * Routes:
 * - `/api/editor/draft` → enable draft mode
 * - `/api/editor/draft/disable` → disable draft mode
 * - `/api/editor/blocks` → block manifest
 * - `/api/editor/pages` → published pages
 * - `/api/editor/publish` → publish content (POST)
 */
export function createEditorApiHandler(config: EditorApiHandlerConfig): {
  GET: (request: Request, context: NextRouteContext) => Promise<Response>
  POST: (request: Request, context: NextRouteContext) => Promise<Response>
  OPTIONS: (request: Request, context: NextRouteContext) => Response
} {
  const draftEnable = createDraftEnableHandler()
  const draftDisable = createDraftDisableHandler()
  const blocksHandler = createBlocksHandler(config.getManifest ? { getManifest: config.getManifest } : undefined)
  const pagesHandler = createPagesHandler(config.getPages)
  const publishHandler = config.onPublish
    ? createPublishHandler(config.onPublish, { publishSecret: config.publishSecret })
    : null

  function matchRoute(path: string[]): string {
    const key = path.join("/")
    if (key === "draft") return "draft-enable"
    if (key === "draft/disable") return "draft-disable"
    if (key === "blocks") return "blocks"
    if (key === "pages") return "pages"
    if (key === "publish") return "publish"
    return "not-found"
  }

  function notFound(request: Request): Response {
    return applyEditorCors(
      new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
      request.headers.get("origin")
    )
  }

  return {
    async GET(request: Request, context: NextRouteContext) {
      checkIntegrationOnce()
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
          return notFound(request)
      }
    },

    async POST(request: Request, context: NextRouteContext) {
      const { path } = await context.params
      const route = matchRoute(path)

      if (route === "publish" && publishHandler) {
        return publishHandler.POST(request)
      }

      return notFound(request)
    },

    OPTIONS(request: Request, context: NextRouteContext) {
      // OPTIONS doesn't need async params resolution for CORS preflight
      return blocksHandler.OPTIONS(request)
    },
  }
}
