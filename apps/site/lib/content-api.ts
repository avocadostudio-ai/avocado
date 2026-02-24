import { pageDocSchema, type PageDoc } from "@ai-site-editor/shared"

const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:4200"

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
  const baseUrl = process.env.ORCHESTRATOR_URL ?? DEFAULT_ORCHESTRATOR_URL
  const baseUrls = buildCandidateBaseUrls(baseUrl)

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

  return null
}
