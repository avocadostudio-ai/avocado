import type { SiteConfig } from "./editor-types"
import { parseArrayOfStrings, parseString } from "./parse-utils"
import { sanitizeSiteId } from "./validators"

export const SITE_LIST_STORAGE_KEY = "editor-site-list-v1"
export const DEFAULT_SITE_HOSTING = "Vercel production site (single shared project)"
export const LEGACY_AVOCADO_SITE_ID = "avocado-stories"
export const LEGACY_AVOCADO_SITE_NAME = "Avocado Stories"
export const LEGACY_AVOCADO_SITE_PURPOSE = "Marketing site for Avocado Stories products, recipes, and sustainability messaging."
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

function parseConfiguredSitePresets(raw: string | undefined): SiteConfig[] {
  const trimmed = raw?.trim()
  if (!trimmed) return []

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((site): site is Record<string, unknown> => Boolean(site && typeof site === "object"))
      .map((site) => {
        const id = sanitizeSiteId(typeof site.id === "string" ? site.id : "")
        const name = parseString(site.name, "")
        const purpose = parseString(site.purpose, "")
        const hosting = parseString(site.hosting, DEFAULT_SITE_HOSTING)
        const vercelProjectId = parseString(site.vercelProjectId, "")
        const vercelTeamId = parseString(site.vercelTeamId, "")
        const vercelProductionUrl = parseString(site.vercelProductionUrl, "")
        const vercelDeployHookUrl = parseString(site.vercelDeployHookUrl, "")
        const tone = parseString(site.tone, "")
        const constraints = parseArrayOfStrings(site.constraints)
        const previewUrl = parseString(site.previewUrl, "")
        return {
          id,
          name,
          purpose,
          hosting,
          vercelProjectId,
          vercelTeamId,
          vercelProductionUrl,
          vercelDeployHookUrl,
          tone,
          constraints,
          ...(previewUrl ? { previewUrl } : {})
        } satisfies SiteConfig
      })
      .filter((site) => site.id.length > 0 && site.name.length > 0)
  } catch {
    return []
  }
}

const CONFIGURED_SITE_PRESETS = parseConfiguredSitePresets(import.meta.env.VITE_SITE_PRESETS_JSON as string | undefined)

const DEFAULT_SITE_PRESETS: SiteConfig[] = [...CONFIGURED_SITE_PRESETS, ...AUTO_SITE_PRESETS]

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

export function defaultSiteList(siteId: string): SiteConfig[] {
  const resolvedId = sanitizeSiteId(siteId) || "dev-site"
  const defaults: SiteConfig[] = [
    {
      id: resolvedId,
      name: siteNameFromId(resolvedId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING,
      vercelProjectId: "",
      vercelTeamId: "",
      vercelProductionUrl: "",
      vercelDeployHookUrl: "",
      tone: "",
      constraints: []
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
        previewUrl?: string
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
        ...(parseString(site.previewUrl, "") ? { previewUrl: parseString(site.previewUrl, "") } : {})
      }))
      .filter((site) => site.id.length > 0 && site.name.length > 0)
      .filter((site) => ENABLE_AUTO_SITE_PRESETS || !AUTO_SITE_PRESET_IDS.has(site.id))
    const mergePresets = (list: SiteConfig[]) => {
      if (DEFAULT_SITE_PRESETS.length === 0) return list
      const presetById = new Map(DEFAULT_SITE_PRESETS.map((p) => [p.id, p]))
      const existingIds = new Set(list.map((site) => site.id))
      const merged = list.map((site) => {
        const preset = presetById.get(site.id)
        if (!preset?.previewUrl || site.previewUrl) return site
        return { ...site, previewUrl: preset.previewUrl }
      })
      for (const preset of DEFAULT_SITE_PRESETS) {
        if (existingIds.has(preset.id)) continue
        merged.push(preset)
      }
      return merged
    }

    if (cleaned.length > 0) {
      if (cleaned.length > 1) {
        const migrated = cleaned.filter((site) => {
          const isLegacyAvocado =
            site.id === LEGACY_AVOCADO_SITE_ID &&
            site.name === LEGACY_AVOCADO_SITE_NAME &&
            (site.purpose === "" || site.purpose === LEGACY_AVOCADO_SITE_PURPOSE) &&
            site.hosting === DEFAULT_SITE_HOSTING
          return !isLegacyAvocado
        })
        if (migrated.length > 0) return mergePresets(migrated)
      }
      return mergePresets(cleaned)
    }
    return mergePresets(defaultSiteList(siteId))
  } catch {
    return defaultSiteList(siteId)
  }
}
