import { getPuckHostApi } from "../../host/runtime"

export function resolvePuckSiteId(): string {
  const hostApi = getPuckHostApi()
  if (typeof window === "undefined") return hostApi.LEGACY_AVOCADO_SITE_ID
  const fromQuery = hostApi.sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  if (fromQuery) return fromQuery
  const editorSiteId = hostApi.sanitizeSiteId(hostApi.resolveEditorSiteId())
  return editorSiteId || hostApi.LEGACY_AVOCADO_SITE_ID
}
