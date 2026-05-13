import type { PageDoc } from "./site-contract"
import type { SiteConfig } from "@avocadostudio-ai/shared"
import { getPublishedPage, getPublishedSlugs, getPublishedSiteConfig } from "./published-content-api"

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
  return import("@ai-site-editor/site-sdk/draft").then(
    ({ fetchEditorPage, fetchEditorSlugs, fetchEditorSiteConfig }) => ({ fetchEditorPage, fetchEditorSlugs, fetchEditorSiteConfig })
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
    const { fetchEditorPage } = await getDraftFetchers()
    return fetchEditorPage(slug, session, siteId)
  }
  return getPublishedPage(slug)
}

export async function getNavSlugs(
  source: ContentSource,
  session: string,
  siteId: string
): Promise<string[]> {
  if (source === "draft") {
    const { fetchEditorSlugs } = await getDraftFetchers()
    const slugs = await fetchEditorSlugs(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getPublishedSlugs()
}

export async function getSiteConfig(
  source: ContentSource,
  session: string,
  siteId: string
): Promise<SiteConfig> {
  if (source === "draft") {
    const { fetchEditorSiteConfig } = await getDraftFetchers()
    return fetchEditorSiteConfig(session, siteId)
  }
  return getPublishedSiteConfig()
}
