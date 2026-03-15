import type { PageDoc } from "./site-contract"
import { fetchDraftPage as fetchFromOrchestrator, fetchDraftSlugs as fetchSlugsFromOrchestrator } from "@ai-site-editor/site-sdk"
import { getPublishedPage, getPublishedSlugs } from "./published-content-api"

export type ContentSource = "published" | "draft"

export function resolveContentSource(draftModeEnabled: boolean): ContentSource {
  if (draftModeEnabled && hasOrchestratorUrl()) return "draft"
  return "published"
}

function hasOrchestratorUrl(): boolean {
  const value = process.env.ORCHESTRATOR_URL?.trim()
  if (value) return true
  return process.env.NODE_ENV !== "production"
}

export async function getPage(
  slug: string,
  source: ContentSource,
  session: string,
  siteId: string
): Promise<PageDoc | null> {
  if (source === "draft") {
    return fetchFromOrchestrator(slug, session, siteId)
  }
  return getPublishedPage(slug)
}

export async function getNavSlugs(
  source: ContentSource,
  session: string,
  siteId: string
): Promise<string[]> {
  if (source === "draft") {
    const slugs = await fetchSlugsFromOrchestrator(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getPublishedSlugs()
}
