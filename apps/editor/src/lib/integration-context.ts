import type { EditorComponentsManifest } from "@ai-site-editor/shared"
import type { SiteCapabilities, SiteConfig } from "./editor-types"

type SiteContextPayload = {
  sitePurpose?: string
  businessContext: {
    purpose?: string
    tone?: string
    constraints?: string[]
  }
  siteContext: {
    siteId: string
    siteName?: string
    purpose?: string
    tone?: string
    constraints?: string[]
  }
}

export function manifestUnavailableChanges(reason?: string) {
  const trimmedReason = typeof reason === "string" ? reason.trim() : ""
  return [
    trimmedReason.length > 0 ? `Manifest issue: ${trimmedReason}` : "Component manifest is unavailable or invalid.",
    "Expose GET /api/editor/components and return a valid manifest to enable structural edits."
  ]
}

export function buildSiteContextPayload(siteId: string, activeSiteConfig: SiteConfig): SiteContextPayload {
  const tone = typeof activeSiteConfig.tone === "string" ? activeSiteConfig.tone.trim() : ""
  const constraints = Array.isArray(activeSiteConfig.constraints)
    ? activeSiteConfig.constraints.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : []
  const purpose = activeSiteConfig.purpose?.trim() || undefined

  return {
    sitePurpose: purpose,
    businessContext: {
      purpose,
      tone: tone || undefined,
      constraints: constraints.length > 0 ? constraints : undefined
    },
    siteContext: {
      siteId,
      siteName: activeSiteConfig.name?.trim() || undefined,
      purpose,
      tone: tone || undefined,
      constraints: constraints.length > 0 ? constraints : undefined
    }
  }
}

export function withIntegrationContext<T extends Record<string, unknown>>(
  payload: T,
  componentManifest?: EditorComponentsManifest | null,
  siteCapabilities?: SiteCapabilities
) {
  return {
    ...payload,
    ...(componentManifest ? { componentsManifest: componentManifest } : {}),
    ...(siteCapabilities ? { siteCapabilities } : {})
  }
}
