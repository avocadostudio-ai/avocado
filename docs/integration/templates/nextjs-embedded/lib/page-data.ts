import type { PageDoc } from "@ai-site-editor/shared"
import { resolveContentSource } from "./draft-content-source"

type DraftFetcher = (slug: string, context: { session?: string; siteId?: string }) => Promise<PageDoc | null>
type PublishedFetcher = (slug: string) => Promise<PageDoc | null> | PageDoc | null

/**
 * Embedded-mode page data contract.
 * - Draft mode ON  -> draft fetcher
 * - Draft mode OFF -> published fetcher
 */
export async function loadPageData(
  slug: string,
  args: {
    fetchDraftPage: DraftFetcher
    fetchPublishedPage: PublishedFetcher
    session?: string
    siteId?: string
  }
): Promise<PageDoc | null> {
  const source = await resolveContentSource()
  if (source === "draft") {
    return args.fetchDraftPage(slug, { session: args.session, siteId: args.siteId })
  }
  return args.fetchPublishedPage(slug)
}

