import { pageDocSchema, type PageDoc } from "./site-contract.ts"
import publishedContent from "./published-content.json" with { type: "json" }

function loadPublishedPages() {
  if (!Array.isArray(publishedContent)) return []
  const parsedPages: PageDoc[] = []
  for (const candidate of publishedContent) {
    const parsed = pageDocSchema.safeParse(candidate)
    if (parsed.success) parsedPages.push(parsed.data)
  }
  return parsedPages
}

const publishedPages = loadPublishedPages()
const publishedPagesBySlug = new Map(publishedPages.map((page) => [page.slug, page] as const))
const publishedSlugs = publishedPages.map((page) => page.slug)

export function getPublishedSlugs() {
  return [...publishedSlugs]
}

export function getPublishedPage(slug: string): PageDoc | null {
  const page = publishedPagesBySlug.get(slug)
  return page ? structuredClone(page) : null
}
