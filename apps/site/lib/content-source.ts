export type SiteContentSource = "published" | "draft"

export function resolveSiteContentSource({
  draftModeEnabled
}: {
  draftModeEnabled: boolean
}): SiteContentSource {
  return draftModeEnabled ? "draft" : "published"
}

