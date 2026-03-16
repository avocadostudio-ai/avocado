import { pageDocSchema, siteConfigSchema } from "@ai-site-editor/shared"
import type { PageDoc, SiteConfig } from "@ai-site-editor/shared"

export function getOrchestratorUrl(): string | null {
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchDraftPage(
  slug: string,
  session: string,
  siteId: string,
  options?: { timeoutMs?: number; orchestratorUrl?: string }
): Promise<PageDoc | null> {
  const configuredBaseUrl = options?.orchestratorUrl ?? getOrchestratorUrl()
  if (!configuredBaseUrl) return null

  const timeout = options?.timeoutMs ?? 5000
  const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`
      const res = await fetchWithTimeout(url, timeout)
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

export async function fetchDraftSlugs(
  session: string,
  siteId: string,
  options?: { timeoutMs?: number; orchestratorUrl?: string }
): Promise<string[]> {
  const configuredBaseUrl = options?.orchestratorUrl ?? getOrchestratorUrl()
  if (!configuredBaseUrl) return []

  const timeout = options?.timeoutMs ?? 5000
  const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
      const res = await fetchWithTimeout(url, timeout)
      if (!res.ok) continue
      const payload = (await res.json()) as { slugs?: unknown }
      if (!Array.isArray(payload.slugs)) continue
      const slugs = payload.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
      if (slugs.length > 0) return slugs
    } catch {
      // Try the next candidate.
    }
  }

  return []
}

export async function fetchDraftSiteConfig(
  session: string,
  siteId: string,
  options?: { timeoutMs?: number; orchestratorUrl?: string }
): Promise<SiteConfig> {
  const configuredBaseUrl = options?.orchestratorUrl ?? getOrchestratorUrl()
  if (!configuredBaseUrl) return {}

  const timeout = options?.timeoutMs ?? 5000
  const baseUrls = buildCandidateBaseUrls(configuredBaseUrl)

  for (const baseUrl of baseUrls) {
    try {
      const url = `${baseUrl}/draft/site-config?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
      const res = await fetchWithTimeout(url, timeout)
      if (!res.ok) continue
      const payload = (await res.json()) as unknown
      const parsed = siteConfigSchema.safeParse(payload)
      if (parsed.success) return parsed.data
    } catch {
      // Try the next candidate.
    }
  }

  return {}
}
