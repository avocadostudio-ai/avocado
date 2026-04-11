import type { CmsMediaConfig, PageTemplate, SiteConfig } from "./editor-types"
import { parseArrayOfStrings, parseString } from "./parse-utils"
import { sanitizeSiteId } from "./validators"

function parseCmsMedia(raw: unknown): CmsMediaConfig | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const provider = obj.provider
  if (provider === "contentful" && typeof obj.spaceId === "string" && typeof obj.deliveryToken === "string") {
    return { provider: "contentful", spaceId: obj.spaceId, deliveryToken: obj.deliveryToken, environment: typeof obj.environment === "string" ? obj.environment : undefined }
  }
  if (provider === "sanity" && typeof obj.projectId === "string") {
    return { provider: "sanity", projectId: obj.projectId, dataset: typeof obj.dataset === "string" ? obj.dataset : undefined }
  }
  if (provider === "strapi" && typeof obj.url === "string") {
    return { provider: "strapi", url: obj.url, token: typeof obj.token === "string" ? obj.token : undefined }
  }
  return null
}

export const SITE_LIST_STORAGE_KEY = "editor-site-list-v1"
export const DELETED_PRESETS_STORAGE_KEY = "editor-site-list-deleted-v1"

function loadDeletedPresetIds(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(DELETED_PRESETS_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

function saveDeletedPresetIds(ids: Set<string>): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(DELETED_PRESETS_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore storage failures.
  }
}

export function markPresetDeleted(id: string): void {
  const ids = loadDeletedPresetIds()
  ids.add(id)
  saveDeletedPresetIds(ids)
}

export function unmarkPresetDeleted(id: string): void {
  const ids = loadDeletedPresetIds()
  if (!ids.delete(id)) return
  saveDeletedPresetIds(ids)
}

export function isPresetId(id: string): boolean {
  return DEFAULT_SITE_PRESETS.some((p) => p.id === id)
}
export const DEFAULT_SITE_HOSTING = "Vercel production site (single shared project)"
export const LEGACY_AVOCADO_SITE_ID = "avocado-stories"
export const LEGACY_AVOCADO_SITE_NAME = "Avocado Stories"
export const LEGACY_AVOCADO_SITE_PURPOSE = "Marketing site for Avocado Stories products, recipes, and sustainability messaging."
export const DEFAULT_AVOCADO_SITE_ID = "avocado-hub"
export const DEFAULT_AVOCADO_SITE_NAME = "The Avocado Hub"
export const DEFAULT_AVOCADO_SITE_PURPOSE = "Healthy living hub — recipes, wellness tips, and sustainability resources."
const IS_DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "1"
const ENABLE_AUTO_SITE_PRESETS = IS_DEMO_MODE || import.meta.env.VITE_ENABLE_AUTO_SITE_PRESETS === "1"
const LOCK_SITE_ID = import.meta.env.VITE_LOCK_SITE_ID === "1"
export const isSiteIdLocked = LOCK_SITE_ID

const AUTO_SITE_PRESET_IDS = new Set(["avocado-magic", "avocado-odyssey", LEGACY_AVOCADO_SITE_ID])

export const AUTO_SITE_PRESETS: SiteConfig[] = ENABLE_AUTO_SITE_PRESETS ? [
  {
    id: "avocado-magic",
    name: "Avocado Magic",
    purpose: "Restored site snapshot: Discover the Magic of Avocados.",
    hosting: DEFAULT_SITE_HOSTING
  },
  {
    id: "avocado-odyssey",
    name: "Avocado Odyssey",
    purpose: "Restored site snapshot: Embark on an Avocado Odyssey.",
    hosting: DEFAULT_SITE_HOSTING
  }
] : []

function parsePageTemplates(raw: unknown): PageTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
    .map((t) => ({ name: parseString(t.name, ""), description: parseString(t.description, "") }))
    .filter((t) => t.name.length > 0 && t.description.length > 0)
}

const DEFAULT_SITE_PRESETS: SiteConfig[] = [
  {
    id: DEFAULT_AVOCADO_SITE_ID,
    name: DEFAULT_AVOCADO_SITE_NAME,
    purpose: DEFAULT_AVOCADO_SITE_PURPOSE,
    hosting: DEFAULT_SITE_HOSTING,
  },
  ...AUTO_SITE_PRESETS,
]

export function siteNameFromId(id: string) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function resolveEditorSiteId() {
  const fallback = sanitizeSiteId((import.meta.env.VITE_SITE_ID as string | undefined) ?? "") || "avocado-stories"
  if (LOCK_SITE_ID) return fallback
  if (typeof window === "undefined") return fallback
  const fromQuery = sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  return fromQuery || fallback
}

/** Read ?previewUrl= from the query string (used when opening a non-preset site). */
export function resolveEditorPreviewUrl(): string | undefined {
  if (typeof window === "undefined") return undefined
  const raw = new URLSearchParams(window.location.search).get("previewUrl")?.trim()
  if (!raw) return undefined
  try { new URL(raw); return raw.replace(/\/+$/, "") } catch { return undefined }
}

export function defaultSiteList(siteId: string): SiteConfig[] {
  const resolvedId = sanitizeSiteId(siteId) || "dev-site"
  const matchedPreset = DEFAULT_SITE_PRESETS.find((preset) => preset.id === resolvedId)
  const defaults: SiteConfig[] = [
    {
      ...(matchedPreset ?? {}),
      id: resolvedId,
      name: matchedPreset?.name ?? siteNameFromId(resolvedId) ?? "Site",
      purpose: matchedPreset?.purpose ?? "",
      hosting: matchedPreset?.hosting ?? DEFAULT_SITE_HOSTING,
      vercelProjectId: matchedPreset?.vercelProjectId ?? "",
      vercelTeamId: matchedPreset?.vercelTeamId ?? "",
      vercelProductionUrl: matchedPreset?.vercelProductionUrl ?? "",
      vercelDeployHookUrl: matchedPreset?.vercelDeployHookUrl ?? "",
      tone: matchedPreset?.tone ?? "",
      constraints: matchedPreset?.constraints ?? [],
    }
  ]
  const existing = new Set(defaults.map((site) => site.id))
  for (const preset of DEFAULT_SITE_PRESETS) {
    if (existing.has(preset.id)) continue
    defaults.push(preset)
    existing.add(preset.id)
  }
  return defaults
}

export function loadSiteListFromStorage(siteId: string) {
  if (LOCK_SITE_ID) return defaultSiteList(siteId)
  if (typeof window === "undefined") return defaultSiteList(siteId)
  try {
    const raw = window.localStorage.getItem(SITE_LIST_STORAGE_KEY)
    if (!raw) return defaultSiteList(siteId)
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return defaultSiteList(siteId)
    const cleaned = parsed
      .filter((site): site is {
        id: string
        name: string
        purpose?: string
        hosting?: string
        vercelProjectId?: string
        vercelTeamId?: string
        vercelProductionUrl?: string
        vercelDeployHookUrl?: string
        tone?: string
        constraints?: unknown
        pageTemplates?: unknown
        previewUrl?: string
        enablePuck?: unknown
      } => {
        return Boolean(
          site &&
            typeof site === "object" &&
            typeof (site as { id?: unknown }).id === "string" &&
            typeof (site as { name?: unknown }).name === "string"
        )
      })
      .map((site) => ({
        id: sanitizeSiteId(site.id),
        name: site.name.trim(),
        purpose: parseString(site.purpose, ""),
        hosting: parseString(site.hosting, DEFAULT_SITE_HOSTING),
        vercelProjectId: parseString(site.vercelProjectId, ""),
        vercelTeamId: parseString(site.vercelTeamId, ""),
        vercelProductionUrl: parseString(site.vercelProductionUrl, ""),
        vercelDeployHookUrl: parseString(site.vercelDeployHookUrl, ""),
        tone: parseString(site.tone, ""),
        constraints: parseArrayOfStrings(site.constraints),
        ...((pts) => pts.length > 0 ? { pageTemplates: pts } : {})(parsePageTemplates(site.pageTemplates)),
        ...(parseString(site.previewUrl, "") ? { previewUrl: parseString(site.previewUrl, "") } : {}),
        ...(parseString((site as { gdriveFolderId?: unknown }).gdriveFolderId, "") ? { gdriveFolderId: parseString((site as { gdriveFolderId?: unknown }).gdriveFolderId, "") } : {}),
        ...(parseCmsMedia((site as { cmsMedia?: unknown }).cmsMedia) ? { cmsMedia: parseCmsMedia((site as { cmsMedia?: unknown }).cmsMedia)! } : {}),
        ...(site.enablePuck === true ? { enablePuck: true } : {})
      }))
      .filter((site) => site.id.length > 0 && site.name.length > 0)
      .filter((site) => ENABLE_AUTO_SITE_PRESETS || !AUTO_SITE_PRESET_IDS.has(site.id))
    const deletedPresetIds = loadDeletedPresetIds()
    const mergePresets = (list: SiteConfig[]) => {
      if (DEFAULT_SITE_PRESETS.length === 0) return list
      const presetById = new Map(DEFAULT_SITE_PRESETS.map((p) => [p.id, p]))
      const existingIds = new Set(list.map((site) => site.id))
      const merged = list.map((site) => {
        const preset = presetById.get(site.id)
        if (!preset) return site
        // Fill-if-empty: do NOT clobber values the user has edited
        // locally. Presets are defaults, not authoritative.
        return {
          ...site,
          ...(!site.previewUrl && preset.previewUrl ? { previewUrl: preset.previewUrl } : {}),
          ...(!site.cmsMedia && preset.cmsMedia ? { cmsMedia: preset.cmsMedia } : {}),
        }
      })
      for (const preset of DEFAULT_SITE_PRESETS) {
        if (existingIds.has(preset.id)) continue
        // User explicitly removed this preset — respect that across reloads.
        if (deletedPresetIds.has(preset.id)) continue
        merged.push(preset)
      }
      return merged
    }

    if (cleaned.length > 0) return mergePresets(cleaned)
    return mergePresets(defaultSiteList(siteId).filter((site) => !deletedPresetIds.has(site.id)))
  } catch {
    return defaultSiteList(siteId)
  }
}
