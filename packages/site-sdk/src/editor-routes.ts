import { applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
import { buildBlockManifest, type BlockManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"

export function createBlocksHandler(options?: {
  getManifest?: () => BlockManifest
}): {
  GET: (request: Request) => Response
  OPTIONS: (request: Request) => Response
} {
  const getManifest = options?.getManifest ?? buildBlockManifest
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

export function createPagesHandler(
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
