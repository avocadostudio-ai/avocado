import { pageDocSchema, type PageDoc } from "./site-contract"

function getConfiguredOrchestratorUrl() {
  const value = process.env.ORCHESTRATOR_URL?.trim()
  if (value) return value.replace(/\/$/, "")
  if (process.env.NODE_ENV !== "production") return "http://127.0.0.1:4200"
  return null
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

export async function fetchDraftPageOnly(slug: string, session: string, siteId: string): Promise<PageDoc | null> {
  const configuredBaseUrl = getConfiguredOrchestratorUrl()
  if (!configuredBaseUrl) return null

  const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)
  for (const candidateBase of baseUrls) {
    try {
      const res = await fetch(
        `${candidateBase}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`,
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

  return null
}

export async function fetchDraftSlugsOnly(session: string, siteId: string): Promise<string[]> {
  const configuredBaseUrl = getConfiguredOrchestratorUrl()
  if (!configuredBaseUrl) return []

  const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)
  for (const candidateBase of baseUrls) {
    try {
      const res = await fetch(
        `${candidateBase}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`,
        { cache: "no-store" }
      )
      if (!res.ok) continue
      const payload = (await res.json()) as { slugs?: unknown }
      if (!Array.isArray(payload.slugs)) continue
      const parsed = payload.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
      if (parsed.length > 0) return parsed
    } catch {
      // Try the next candidate.
    }
  }

  return []
}
