import { draftMode } from "next/headers"
import { NextResponse } from "next/server"
import { createDraftEnableHandlerCore, createDraftDisableHandlerCore } from "./draft-routes-core.ts"
import type { DraftRouteAdapter } from "./draft-routes-core.ts"

function createNextAdapter(): DraftRouteAdapter {
  return {
    enableDraftMode: async () => { (await draftMode()).enable() },
    disableDraftMode: async () => { (await draftMode()).disable() },
    createRedirect: (url, cookies) => {
      const response = NextResponse.redirect(url)
      for (const c of cookies ?? []) {
        if (c.delete) {
          response.cookies.delete(c.name)
        } else {
          response.cookies.set(c.name, c.value, { path: "/", sameSite: "lax" })
        }
      }
      return response
    },
  }
}

export function createDraftEnableHandler(): (request: Request) => Promise<Response> {
  return createDraftEnableHandlerCore(createNextAdapter())
}

export function createDraftDisableHandler(): (request: Request) => Promise<Response> {
  return createDraftDisableHandlerCore(createNextAdapter())
}
