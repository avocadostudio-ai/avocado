import type { PageDoc } from "./site-contract"
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

// Lazy-load orchestrator fetch so published builds don't bundle it
let draftFetchersPromise: ReturnType<typeof loadDraftFetchers> | null = null
function loadDraftFetchers() {
  return import("@ai-site-editor/site-sdk").then(
    ({ fetchDraftPage, fetchDraftSlugs }) => ({ fetchDraftPage, fetchDraftSlugs })
  )
}
function getDraftFetchers() {
  if (!draftFetchersPromise) draftFetchersPromise = loadDraftFetchers()
  return draftFetchersPromise
}

export async function getPage(
  slug: string,
  source: ContentSource,
  session: string,
  siteId: string
): Promise<PageDoc | null> {
  if (source === "draft") {
    const { fetchDraftPage } = await getDraftFetchers()
    return fetchDraftPage(slug, session, siteId)
  }
  return getPublishedPage(slug)
}

export async function getNavSlugs(
  source: ContentSource,
  session: string,
  siteId: string
): Promise<string[]> {
  if (source === "draft") {
    const { fetchDraftSlugs } = await getDraftFetchers()
    const slugs = await fetchDraftSlugs(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getPublishedSlugs()
}
