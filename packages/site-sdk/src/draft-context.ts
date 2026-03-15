import { draftMode, cookies } from "next/headers"
import type { DraftContext, SearchParamsRecord } from "./types.ts"
import { DRAFT_SESSION_COOKIE, DRAFT_SITE_COOKIE, EDITOR_ORIGIN_COOKIE, normalizeOrigin } from "./draft-common.ts"

export function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export async function resolveDraftContext(
  searchParams: SearchParamsRecord,
  options?: {
    defaultSession?: string
    defaultSiteId?: string
    defaultEditorOrigin?: string
  }
): Promise<DraftContext | null> {
  const jar = await cookies()
  const draft = await draftMode()

  const isDev = process.env.NODE_ENV !== "production"
  const isDraftMode = draft.isEnabled
  const isEditorParam = single(searchParams.__editor) === "1"
  const isContentStoreEnabled = isDev || isDraftMode || isEditorParam

  if (!isContentStoreEnabled) return null

  const defaultSession = options?.defaultSession ?? process.env.DRAFT_DEFAULT_SESSION?.trim() ?? "dev"
  const defaultSiteId = options?.defaultSiteId ?? process.env.DRAFT_DEFAULT_SITE_ID?.trim() ?? ""
  const defaultEditorOrigin = options?.defaultEditorOrigin
    ?? process.env.NEXT_PUBLIC_EDITOR_ORIGIN?.replace(/\/+$/, "")
    ?? (isDev ? "http://localhost:4100" : "")

  const siteId = single(searchParams.siteId) ?? jar.get(DRAFT_SITE_COOKIE)?.value?.trim() ?? defaultSiteId
  if (!siteId) return null

  const session = single(searchParams.session) ?? jar.get(DRAFT_SESSION_COOKIE)?.value?.trim() ?? defaultSession
  const editorOrigin = normalizeOrigin(single(searchParams.editorOrigin))
    ?? normalizeOrigin(jar.get(EDITOR_ORIGIN_COOKIE)?.value)
    ?? defaultEditorOrigin

  return { session, siteId, editorOrigin }
}

export function isTileMode(searchParams: SearchParamsRecord): boolean {
  return single(searchParams.__tile) === "1"
}
