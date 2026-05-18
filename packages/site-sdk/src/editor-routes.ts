import { applyEditorCors, createEditorCorsOptionsHandler } from "./editor-cors.ts"
import { buildBlockManifest, type BlockManifest } from "./editor-manifest.ts"
import type { PageDoc } from "./types.ts"
import type { SiteConfig } from "@avocadostudio-ai/shared"

export type InlineAsset = {
  /** base64-encoded image bytes */
  data: string
  /** MIME type, e.g. "image/png" */
  mimeType: string
  /** Original filename */
  fileName: string
}

export type PublishContext = {
  /** Base64-encoded images for localhost/generated URLs that can't be fetched remotely */
  assets?: Record<string, InlineAsset>
}

export type OnPublishFn = (
  pages: PageDoc[],
  config: SiteConfig,
  context?: PublishContext
) => Promise<{ ok: boolean; error?: string }>

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
  getPages: () => PageDoc[] | Promise<PageDoc[]>,
  getSiteConfig?: () => SiteConfig | undefined | Promise<SiteConfig | undefined>
): {
  GET: (request: Request) => Promise<Response>
  OPTIONS: (request: Request) => Response
} {
  return {
    OPTIONS: createEditorCorsOptionsHandler(),
    async GET(request: Request) {
      const pages = await getPages()
      const siteConfig = getSiteConfig ? await getSiteConfig() : undefined
      const body = siteConfig ? { pages, siteConfig } : { pages }
      const response = new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      })
      return applyEditorCors(response, request.headers.get("origin"))
    }
  }
}

export function createPublishHandler(
  onPublish: OnPublishFn,
  options?: { publishSecret?: string }
): {
  POST: (request: Request) => Promise<Response>
  OPTIONS: (request: Request) => Response
} {
  return {
    OPTIONS: createEditorCorsOptionsHandler(),
    async POST(request: Request) {
      // Verify publish token if configured
      const secret = options?.publishSecret
      if (secret) {
        const provided = request.headers.get("x-publish-token")?.trim()
        if (!provided || provided !== secret) {
          const res = new Response(
            JSON.stringify({ ok: false, error: "Invalid or missing publish token" }),
            { status: 401, headers: { "Content-Type": "application/json" } }
          )
          return applyEditorCors(res, request.headers.get("origin"))
        }
      }

      try {
        const body = (await request.json()) as {
          pages?: unknown
          siteConfig?: unknown
          assets?: Record<string, InlineAsset>
        }

        if (!Array.isArray(body.pages)) {
          const res = new Response(
            JSON.stringify({ ok: false, error: "pages must be an array" }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          )
          return applyEditorCors(res, request.headers.get("origin"))
        }

        const pages = body.pages as PageDoc[]
        const config = (body.siteConfig ?? {}) as SiteConfig
        const context: PublishContext = { assets: body.assets }
        const result = await onPublish(pages, config, context)

        const status = result.ok ? 200 : 500
        const res = new Response(
          JSON.stringify({ ok: result.ok, slugs: pages.map((p) => p.slug), error: result.error }),
          { status, headers: { "Content-Type": "application/json" } }
        )
        return applyEditorCors(res, request.headers.get("origin"))
      } catch (err) {
        const message = err instanceof Error ? err.message : "publish failed"
        const res = new Response(
          JSON.stringify({ ok: false, error: message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
        return applyEditorCors(res, request.headers.get("origin"))
      }
    }
  }
}
