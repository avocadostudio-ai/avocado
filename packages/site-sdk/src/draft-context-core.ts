import type { DraftContext, SearchParamsRecord } from "./types.ts"
import { DRAFT_SESSION_COOKIE, DRAFT_SITE_COOKIE, EDITOR_ORIGIN_COOKIE, normalizeOrigin } from "./draft-common.ts"
import { single } from "./draft-context.ts"

export { single } from "./draft-context.ts"

export type DraftModeAdapter = {
  isDraftMode: boolean
  getCookie: (name: string) => string | undefined
}

export async function resolveDraftContextCore(
  searchParams: SearchParamsRecord,
  adapter: DraftModeAdapter,
  options?: {
    defaultSession?: string
    defaultSiteId?: string
    defaultEditorOrigin?: string
  }
): Promise<DraftContext | null> {
  const isDev = process.env.NODE_ENV !== "production"
  const isEditorParam = single(searchParams.__editor) === "1"
  const isContentStoreEnabled = isDev || adapter.isDraftMode || isEditorParam

  if (!isContentStoreEnabled) return null

  const defaultSession = options?.defaultSession ?? process.env.DRAFT_DEFAULT_SESSION?.trim() ?? "dev"
  const defaultSiteId = options?.defaultSiteId ?? process.env.DRAFT_DEFAULT_SITE_ID?.trim() ?? ""
  const defaultEditorOrigin = options?.defaultEditorOrigin
    ?? process.env.NEXT_PUBLIC_EDITOR_ORIGIN?.replace(/\/+$/, "")
    ?? (isDev ? "http://localhost:4100" : "")

  const siteId = single(searchParams.siteId) ?? adapter.getCookie(DRAFT_SITE_COOKIE)?.trim() ?? defaultSiteId
  if (!siteId) return null

  const session = single(searchParams.session) ?? adapter.getCookie(DRAFT_SESSION_COOKIE)?.trim() ?? defaultSession
  const editorOrigin = normalizeOrigin(single(searchParams.editorOrigin))
    ?? normalizeOrigin(adapter.getCookie(EDITOR_ORIGIN_COOKIE))
    ?? defaultEditorOrigin

  return { session, siteId, editorOrigin }
}
