import type { PageDoc } from "@ai-site-editor/shared"
import { type SiteContentSource } from "./content-source.ts"

export type ContentResolverDeps = {
  fetchDraftPage: (slug: string, session: string, siteId: string, strictDraft?: boolean) => Promise<PageDoc | null>
  fetchDraftSlugs: (session: string, siteId: string, strictDraft?: boolean) => Promise<string[]>
  getPublishedPage: (slug: string) => PageDoc | null
  getPublishedSlugs: () => string[]
}

export async function resolvePageAndNav(
  {
    source,
    slug,
    session,
    siteId
  }: {
    source: SiteContentSource
    slug: string
    session: string
    siteId: string
  },
  deps: ContentResolverDeps
): Promise<{ page: PageDoc | null; slugs: string[] }> {
  if (source === "draft") {
    const page = await deps.fetchDraftPage(slug, session, siteId, true)
    const slugs = await deps.fetchDraftSlugs(session, siteId, true)
    return { page, slugs }
  }

  return {
    page: deps.getPublishedPage(slug),
    slugs: deps.getPublishedSlugs()
  }
}
