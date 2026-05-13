import { validateDraftSecret, getSafeInternalRedirectPath } from "@avocadostudio-ai/shared"
import { DRAFT_SESSION_COOKIE, DRAFT_SITE_COOKIE, EDITOR_ORIGIN_COOKIE, normalizeOrigin } from "./draft-common.ts"

export type DraftRouteAdapter = {
  enableDraftMode: () => Promise<void>
  disableDraftMode: () => Promise<void>
  createRedirect: (url: URL, cookies?: Array<{ name: string; value: string; delete?: boolean }>) => Response
}

export function createDraftEnableHandlerCore(adapter: DraftRouteAdapter): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)
    const validation = validateDraftSecret(url.searchParams.get("secret"), process.env)

    if (!validation.ok && validation.reason === "missing_config") {
      return new Response(
        JSON.stringify({ ok: false, error: "Draft mode secret is not configured. Set DRAFT_MODE_SECRET or NEXT_DRAFT_MODE_SECRET." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    if (!validation.ok && validation.reason === "invalid_secret") {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid draft mode secret." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      )
    }

    const redirectPath = getSafeInternalRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
    await adapter.enableDraftMode()

    const redirectUrl = new URL(redirectPath, url)
    const cookies: Array<{ name: string; value: string; delete?: boolean }> = []

    const session = redirectUrl.searchParams.get("session")?.trim()
    const siteId = redirectUrl.searchParams.get("siteId")?.trim()
    const editorOrigin = normalizeOrigin(redirectUrl.searchParams.get("editorOrigin"))

    if (session) cookies.push({ name: DRAFT_SESSION_COOKIE, value: session })
    if (siteId) cookies.push({ name: DRAFT_SITE_COOKIE, value: siteId })
    if (editorOrigin) cookies.push({ name: EDITOR_ORIGIN_COOKIE, value: encodeURIComponent(editorOrigin) })

    return adapter.createRedirect(redirectUrl, cookies)
  }
}

export function createDraftDisableHandlerCore(adapter: DraftRouteAdapter): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)
    await adapter.disableDraftMode()

    const redirectPath = getSafeInternalRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
    const redirectUrl = new URL(redirectPath, url)

    return adapter.createRedirect(redirectUrl, [
      { name: DRAFT_SESSION_COOKIE, value: "", delete: true },
      { name: DRAFT_SITE_COOKIE, value: "", delete: true },
      { name: EDITOR_ORIGIN_COOKIE, value: "", delete: true }
    ])
  }
}
