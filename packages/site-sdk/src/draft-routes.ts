import { draftMode } from "next/headers"
import { NextResponse } from "next/server"
import { validateDraftSecret, getSafeInternalRedirectPath } from "@ai-site-editor/shared"
import { DRAFT_SESSION_COOKIE, DRAFT_SITE_COOKIE, EDITOR_ORIGIN_COOKIE, normalizeOrigin } from "./draft-common.ts"

export function createDraftEnableHandler(): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)
    const validation = validateDraftSecret(url.searchParams.get("secret"), process.env)

    if (!validation.ok && validation.reason === "missing_config") {
      return NextResponse.json(
        { ok: false, error: "Draft mode secret is not configured. Set DRAFT_MODE_SECRET or NEXT_DRAFT_MODE_SECRET." },
        { status: 500 }
      )
    }

    if (!validation.ok && validation.reason === "invalid_secret") {
      return NextResponse.json({ ok: false, error: "Invalid draft mode secret." }, { status: 401 })
    }

    const redirectPath = getSafeInternalRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
    const state = await draftMode()
    state.enable()

    const redirectUrl = new URL(redirectPath, url)
    const response = NextResponse.redirect(redirectUrl)

    const session = redirectUrl.searchParams.get("session")?.trim()
    const siteId = redirectUrl.searchParams.get("siteId")?.trim()
    const editorOrigin = normalizeOrigin(redirectUrl.searchParams.get("editorOrigin"))

    if (session) response.cookies.set(DRAFT_SESSION_COOKIE, session, { path: "/", sameSite: "lax" })
    if (siteId) response.cookies.set(DRAFT_SITE_COOKIE, siteId, { path: "/", sameSite: "lax" })
    if (editorOrigin) response.cookies.set(EDITOR_ORIGIN_COOKIE, encodeURIComponent(editorOrigin), { path: "/", sameSite: "lax" })

    return response
  }
}

export function createDraftDisableHandler(): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url)
    const state = await draftMode()
    state.disable()

    const redirectPath = getSafeInternalRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
    const response = NextResponse.redirect(new URL(redirectPath, url))
    response.cookies.delete(DRAFT_SESSION_COOKIE)
    response.cookies.delete(DRAFT_SITE_COOKIE)
    response.cookies.delete(EDITOR_ORIGIN_COOKIE)
    return response
  }
}
