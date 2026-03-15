export const DRAFT_SESSION_COOKIE = "editor_draft_session"
export const DRAFT_SITE_COOKIE = "editor_draft_site_id"
export const EDITOR_ORIGIN_COOKIE = "editor_origin"

export function normalizeOrigin(value: string | null | undefined): string | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  try {
    const parsed = new URL(decodeURIComponent(raw))
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}
