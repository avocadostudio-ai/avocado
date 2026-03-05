import { fetchDraftPage, fetchDraftSlugs } from "./content-api"
import { resolvePageAndNav, type ContentResolverDeps } from "./content-resolver"
import { getPublishedPage, getPublishedSlugs } from "./published-content-api"

const runtimeDeps: ContentResolverDeps = {
  fetchDraftPage,
  fetchDraftSlugs,
  getPublishedPage,
  getPublishedSlugs
}

export async function resolveRuntimePageAndNav(args: {
  source: "published" | "draft"
  slug: string
  session: string
  siteId: string
}) {
  return resolvePageAndNav(args, runtimeDeps)
}

