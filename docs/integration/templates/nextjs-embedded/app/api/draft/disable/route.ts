import { draftMode } from "next/headers"
import { NextResponse } from "next/server"
import { getSafeRedirectPath } from "../helpers"

export async function GET(request: Request) {
  const url = new URL(request.url)
  const state = await draftMode()
  state.disable()

  const redirectPath = getSafeRedirectPath(url.searchParams.get("redirect") ?? url.searchParams.get("slug"))
  return NextResponse.redirect(new URL(redirectPath, url))
}

