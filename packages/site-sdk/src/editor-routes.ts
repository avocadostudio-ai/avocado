import { applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
import { buildComponentsManifest, type EditorComponentsManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"

export function createComponentsHandler(options?: {
  getManifest?: () => EditorComponentsManifest
}): {
  GET: (request: Request) => Response
  OPTIONS: (request: Request) => Response
} {
  const getManifest = options?.getManifest ?? buildComponentsManifest
  return {
    OPTIONS: createEditorCorsOptionsHandler(),
    GET(request: Request) {
      const manifest = getManifest()
      const response = new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      })
      return applyEditorCors(response, request.headers.get("origin"))
    }
  }
}

export function createBootstrapPagesHandler(
  getPages: () => PageDoc[]
): {
  GET: (request: Request) => Response
  OPTIONS: (request: Request) => Response
} {
  return {
    OPTIONS: createEditorCorsOptionsHandler(),
    GET(request: Request) {
      const pages = getPages()
      const response = new Response(JSON.stringify({ pages }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      })
      return applyEditorCors(response, request.headers.get("origin"))
    }
  }
}
