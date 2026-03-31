import type { BlockManifest, PageDoc } from "@ai-site-editor/shared"
import { getPuckHostApi } from "../../host/runtime"
import { fetchJson } from "./fetch-json"
import { type PlannerFeatures } from "./types"

export async function fetchEditorPages(siteId: string): Promise<PageDoc[]> {
  const hostApi = getPuckHostApi()
  const source = await fetchJson<{ pages?: unknown }>(
    `${hostApi.siteOrigin}/api/editor/pages?siteId=${encodeURIComponent(siteId)}`
  )
  return Array.isArray(source.pages) ? source.pages as PageDoc[] : []
}

export async function bootstrapDraft(session: string, siteId: string, pages: PageDoc[]): Promise<void> {
  const hostApi = getPuckHostApi()
  // Preserve existing draft content for the session (including unsynced local edits).
  // The orchestrator bootstrap route will initialize only when draft is empty.
  await fetch(`${hostApi.orchestrator}/draft/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session,
      siteId,
      overwrite: false,
      ...(pages.length > 0 ? { pages } : {}),
    })
  }).catch(() => undefined)
}

export function fetchManifest(): Promise<BlockManifest> {
  const hostApi = getPuckHostApi()
  return fetchJson<BlockManifest>(`${hostApi.siteOrigin}/api/editor/blocks`)
}

export async function fetchDraftSlugs(session: string, siteId: string): Promise<string[]> {
  const hostApi = getPuckHostApi()
  const payload = await fetchJson<{ slugs?: string[] }>(
    `${hostApi.orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
  )
  return Array.isArray(payload.slugs) && payload.slugs.length > 0 ? payload.slugs : ["/"]
}

export function fetchDraftPage(session: string, siteId: string, slug: string): Promise<PageDoc> {
  const hostApi = getPuckHostApi()
  return fetchJson<PageDoc>(
    `${hostApi.orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`
  )
}

export async function applyDraftOps(
  session: string,
  siteId: string,
  ops: Array<Record<string, unknown>>
): Promise<boolean> {
  const hostApi = getPuckHostApi()
  if (ops.length === 0) return true
  const res = await fetch(`${hostApi.orchestrator}/ops`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, siteId, ops }),
  })
  const payload = await res.json().catch(() => ({} as { status?: string }))
  return res.ok && payload?.status === "applied"
}

export async function fetchPlannerFeatures(): Promise<PlannerFeatures | null> {
  const hostApi = getPuckHostApi()
  const urls = [`${hostApi.orchestrator}/status/planner`]
  if (hostApi.orchestrator.includes("localhost")) {
    urls.push(`${hostApi.orchestrator.replace("localhost", "127.0.0.1")}/status/planner`)
  }

  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const data = (await res.json()) as { features?: PlannerFeatures }
      if (data.features) return data.features
      return null
    } catch {
      // Try fallback URL if available.
    }
  }

  return null
}
