import type { PageDoc } from "./site-contract"
import { fetchDraftPageOnly, fetchDraftSlugsOnly } from "./draft-content-api"
import { getPublishedPage, getPublishedSlugs } from "./published-content-api"

export { getPublishedSlugs }

export async function fetchDraftPage(slug: string, session: string, siteId: string, strictDraft = false): Promise<PageDoc | null> {
  const page = await fetchDraftPageOnly(slug, session, siteId)
  if (page) return page
  if (strictDraft) return null
  return getPublishedPage(slug)
}

export async function fetchDraftSlugs(session: string, siteId: string, strictDraft = false): Promise<string[]> {
  const slugs = await fetchDraftSlugsOnly(session, siteId)
  if (slugs.length > 0) return slugs
  if (strictDraft) return []
  return getPublishedSlugs()
}
