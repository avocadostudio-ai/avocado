import { pageDocSchema, type PageDoc } from "@ai-site-editor/shared"
import publishedContent from "./published-content.json"

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

function localFallbackPage(slug: string): PageDoc | null {
  const page = publishedPagesBySlug.get(slug)
  return page ? structuredClone(page) : null
}

function getConfiguredOrchestratorUrl() {
  const value = process.env.ORCHESTRATOR_URL?.trim()
  if (!value) return null
  return value.replace(/\/$/, "")
}

function buildCandidateBaseUrls(configuredBaseUrl: string): string[] {
  const candidates = [configuredBaseUrl]

  try {
    const parsed = new URL(configuredBaseUrl)
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1"
      candidates.push(parsed.toString().replace(/\/$/, ""))
    } else if (parsed.hostname === "127.0.0.1") {
      parsed.hostname = "localhost"
      candidates.push(parsed.toString().replace(/\/$/, ""))
    }
  } catch {
    // Keep the configured URL as-is.
  }

  return candidates
}

export async function fetchDraftPage(slug: string, session: string): Promise<PageDoc | null> {
  const configuredBaseUrl = getConfiguredOrchestratorUrl()
  if (configuredBaseUrl) {
    const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)

    for (const candidateBase of baseUrls) {
      try {
        const res = await fetch(
          `${candidateBase}/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent(slug)}`,
          { cache: "no-store" }
        )

        if (!res.ok) continue
        const payload = (await res.json()) as unknown
        const parsed = pageDocSchema.safeParse(payload)
        if (parsed.success) return parsed.data
      } catch {
        // Try the next candidate.
      }
    }
  }

  return localFallbackPage(slug)
}

export async function fetchDraftSlugs(session: string): Promise<string[]> {
  const configuredBaseUrl = getConfiguredOrchestratorUrl()
  if (configuredBaseUrl) {
    const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)

    for (const candidateBase of baseUrls) {
      try {
        const res = await fetch(`${candidateBase}/draft/slugs?session=${encodeURIComponent(session)}`, { cache: "no-store" })
        if (!res.ok) continue
        const payload = (await res.json()) as { slugs?: unknown }
        if (!Array.isArray(payload.slugs)) continue
        const parsed = payload.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        if (parsed.length > 0) return parsed
      } catch {
        // Try the next candidate.
      }
    }
  }

  return publishedSlugs
}
