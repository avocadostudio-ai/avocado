import { applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
import { buildComponentsManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"

export function createComponentsHandler(): {
  GET: (request: Request) => Response
  OPTIONS: (request: Request) => Response
} {
  return {
    OPTIONS: createEditorCorsOptionsHandler(),
    GET(request: Request) {
      const manifest = buildComponentsManifest()
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
