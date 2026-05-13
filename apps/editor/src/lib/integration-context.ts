import type { BlockManifest } from "@avocadostudio-ai/shared"
import type { PageTemplate, SiteCapabilities, SiteConfig } from "./editor-types"
import { parseArrayOfStrings, parseString } from "./parse-utils"

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
    pageTemplates?: PageTemplate[]
    gdriveFolderId?: string
  }
}

export function manifestUnavailableChanges(reason?: string) {
  const trimmedReason = parseString(reason, "")
  return [
    trimmedReason.length > 0 ? `Manifest issue: ${trimmedReason}` : "Block manifest is unavailable or invalid.",
    "Expose GET /api/editor/blocks and return a valid manifest to enable structural edits."
  ]
}

export function buildSiteContextPayload(siteId: string, activeSiteConfig: SiteConfig): SiteContextPayload {
  const tone = parseString(activeSiteConfig.tone, "")
  const constraints = parseArrayOfStrings(activeSiteConfig.constraints)
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
      constraints: constraints.length > 0 ? constraints : undefined,
      pageTemplates: activeSiteConfig.pageTemplates?.filter(t => t.name && t.description),
      gdriveFolderId: activeSiteConfig.gdriveFolderId?.trim() || undefined
    }
  }
}

export function withIntegrationContext<T extends Record<string, unknown>>(
  payload: T,
  componentManifest?: BlockManifest | null,
  siteCapabilities?: SiteCapabilities
) {
  return {
    ...payload,
    ...(componentManifest ? { componentsManifest: componentManifest } : {}),
    ...(siteCapabilities ? { siteCapabilities } : {})
  }
}
