import { draftMode } from "next/headers"
import { NextResponse } from "next/server"
import { getSafeRedirectPath, isValidDraftSecret } from "./helpers"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const validation = isValidDraftSecret(url.searchParams.get("secret"))

  if (!validation.ok && validation.reason === "missing_config") {
    return NextResponse.json(
      { ok: false, error: "Draft mode secret is not configured. Set DRAFT_MODE_SECRET or NEXT_DRAFT_MODE_SECRET." },
      { status: 500 }
    )
  }

  if (!validation.ok && validation.reason === "invalid_secret") {
    return NextResponse.json({ ok: false, error: "Invalid draft mode secret." }, { status: 401 })
  }

  const target = getSafeRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
  const state = await draftMode()
  state.enable()

  return NextResponse.redirect(new URL(target, url))
}
