export type SiteContentSource = "published" | "draft"

export function resolveSiteContentSource({
  draftModeEnabled
}: {
  draftModeEnabled: boolean
}): SiteContentSource {
  if (draftModeEnabled && hasOrchestratorUrl()) return "draft"
  return "published"
}

function hasOrchestratorUrl(): boolean {
  const value = process.env.ORCHESTRATOR_URL?.trim()
  if (value) return true
  // In dev, orchestrator defaults to localhost
  return process.env.NODE_ENV !== "production"
}

