export function resolveOrigin(value: string | undefined, fallback: string) {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, "")
}

export const siteOrigin = resolveOrigin(import.meta.env.VITE_SITE_ORIGIN as string | undefined, "http://localhost:3000")
export const orchestrator = resolveOrigin(import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined, "http://localhost:4200")
export const publishToken = import.meta.env.VITE_PUBLISH_TOKEN as string | undefined
export const enablePatchTransport = import.meta.env.VITE_ENABLE_PATCH_TRANSPORT === "1"
export const siteDraftSecret = (import.meta.env.VITE_SITE_DRAFT_SECRET as string | undefined)?.trim() ?? ""

export function buildSitePathWithQuery(pathname: string, params: Record<string, string | undefined>) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue
    query.set(key, value)
  }
  const queryString = query.toString()
  return queryString.length > 0 ? `${normalizedPath}?${queryString}` : normalizedPath
}

export function resolveSiteOrigin(config?: { previewUrl?: string }) {
  const override = config?.previewUrl?.trim()?.replace(/\/+$/, "")
  return override || siteOrigin
}

export function buildSiteDraftEnableUrl(pathname: string, params: Record<string, string | undefined>, origin?: string) {
  const base = origin || siteOrigin
  const redirectPath = buildSitePathWithQuery(pathname, params)
  if (!siteDraftSecret) {
    const direct = new URL(`${base}${redirectPath}`)
    if (!direct.searchParams.has("__editor")) direct.searchParams.set("__editor", "1")
    return direct.toString()
  }
  const entry = new URL(`${base}/api/draft`)
  entry.searchParams.set("secret", siteDraftSecret)
  entry.searchParams.set("redirect", redirectPath)
  return entry.toString()
}

export function buildSiteDraftDisableUrl(pathname: string, params: Record<string, string | undefined>, origin?: string) {
  const base = origin || siteOrigin
  const redirectPath = buildSitePathWithQuery(pathname, params)
  const entry = new URL(`${base}/api/draft/disable`)
  entry.searchParams.set("redirect", redirectPath)
  return entry.toString()
}
