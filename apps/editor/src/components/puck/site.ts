import { LEGACY_AVOCADO_SITE_ID, resolveEditorSiteId, sanitizeSiteId } from "../../lib/editor-utils"

export function resolvePuckSiteId(): string {
  if (typeof window === "undefined") return LEGACY_AVOCADO_SITE_ID
  const fromQuery = sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  if (fromQuery) return fromQuery
  const editorSiteId = sanitizeSiteId(resolveEditorSiteId())
  return editorSiteId || LEGACY_AVOCADO_SITE_ID
}
