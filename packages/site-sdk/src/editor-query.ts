const EDITOR_KEYS = ["session", "siteId", "editorOrigin", "__editor"] as const

export function buildEditorQuerySuffix(searchParams: URLSearchParams): string {
  const params = new URLSearchParams()
  for (const key of EDITOR_KEYS) {
    const val = searchParams.get(key)
    if (val) params.set(key, val)
  }
  const str = params.toString()
  return str ? `?${str}` : ""
}

export function buildSlug(parts?: string[]): string {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}
