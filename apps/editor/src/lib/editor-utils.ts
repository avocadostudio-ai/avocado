import { COMPLEX_TASK_HEURISTICS } from "../config/complex-task-heuristics"
import type { PreviewWidthPreset, SiteConfig } from "./editor-types"

export const SITE_LIST_STORAGE_KEY = "editor-site-list-v1"
export const DEFAULT_SITE_HOSTING = "Vercel production site (single shared project)"
export const LEGACY_AVOCADO_SITE_ID = "avocado-stories"
export const LEGACY_AVOCADO_SITE_NAME = "Avocado Stories"
export const LEGACY_AVOCADO_SITE_PURPOSE = "Marketing site for Avocado Stories products, recipes, and sustainability messaging."
export const AUTO_SITE_PRESETS: SiteConfig[] = [
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
]

export const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
export const AI_PERFORMANCE_PREFIX = "__ai_performance__:"
export const DEBUG_MODE_STORAGE_KEY = "editor-debug-mode-v1"
export const MODEL_KEY_STORAGE_KEY = "editor-model-key-v1"
export const PROVIDER_STORAGE_KEY = "editor-provider-v1"

export const previewPresetWidths: Record<PreviewWidthPreset, number> = {
  desktop: 1200,
  tablet: 834,
  mobile: 390
}

export const siteOrigin = resolveOrigin(import.meta.env.VITE_SITE_ORIGIN as string | undefined, "http://localhost:3000")
export const orchestrator = resolveOrigin(import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined, "http://localhost:4200")
export const publishToken = import.meta.env.VITE_PUBLISH_TOKEN as string | undefined
export const enablePatchTransport = import.meta.env.VITE_ENABLE_PATCH_TRANSPORT === "1"

export function sanitizeSiteId(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function resolveEditorSiteId() {
  const fallback = sanitizeSiteId((import.meta.env.VITE_SITE_ID as string | undefined) ?? "") || "dev-site"
  if (typeof window === "undefined") return fallback
  const fromQuery = sanitizeSiteId(new URLSearchParams(window.location.search).get("siteId") ?? "")
  return fromQuery || fallback
}

export function defaultSiteList(siteId: string): SiteConfig[] {
  const resolvedId = sanitizeSiteId(siteId) || "dev-site"
  return [
    {
      id: resolvedId,
      name: siteNameFromId(resolvedId) || "Site",
      purpose: "",
      hosting: DEFAULT_SITE_HOSTING
    }
  ]
}

export function loadSiteListFromStorage(siteId: string) {
  if (typeof window === "undefined") return defaultSiteList(siteId)
  try {
    const raw = window.localStorage.getItem(SITE_LIST_STORAGE_KEY)
    if (!raw) return defaultSiteList(siteId)
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return defaultSiteList(siteId)
    const cleaned = parsed
      .filter((site): site is { id: string; name: string; purpose?: string; hosting?: string } => {
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
        purpose: typeof site.purpose === "string" ? site.purpose.trim() : "",
        hosting: typeof site.hosting === "string" && site.hosting.trim().length > 0 ? site.hosting.trim() : DEFAULT_SITE_HOSTING
      }))
      .filter((site) => site.id.length > 0 && site.name.length > 0)
    const mergePresets = (list: SiteConfig[]) => {
      const existingIds = new Set(list.map((site) => site.id))
      const merged = [...list]
      for (const preset of AUTO_SITE_PRESETS) {
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
    return [...defaultSiteList(siteId), ...AUTO_SITE_PRESETS]
  }
}

export function siteNameFromId(id: string) {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function resolveOrigin(value: string | undefined, fallback: string) {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.replace(/\/+$/, "")
}

export function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function resolveDefaultDebugMode() {
  const envEnabled = /^(1|true|yes|on)$/i.test((import.meta.env.VITE_CHAT_DEBUG as string | undefined) ?? "")
  if (envEnabled) return true
  if (typeof window === "undefined") return false
  const stored = window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY)
  return /^(1|true|yes|on)$/i.test(stored ?? "")
}

const VALID_MODEL_KEYS = new Set<string>(["fast", "balanced", "reasoning", "codex"])
const VALID_PROVIDERS = new Set<string>(["openai", "anthropic"])

export function resolveDefaultModelKey(): import("./editor-types").ModelKey {
  if (typeof window === "undefined") return "balanced"
  const stored = window.localStorage.getItem(MODEL_KEY_STORAGE_KEY)
  if (stored && VALID_MODEL_KEYS.has(stored)) return stored as import("./editor-types").ModelKey
  return "balanced"
}

export function resolveDefaultProvider(): import("./editor-types").AIProvider {
  if (typeof window === "undefined") return "openai"
  const stored = window.localStorage.getItem(PROVIDER_STORAGE_KEY)
  if (stored && VALID_PROVIDERS.has(stored)) return stored as import("./editor-types").AIProvider
  return "openai"
}

export function slugLabel(route: string) {
  if (route === "/") return "Home (/)"
  const pretty = route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
  return `${pretty || route} (${route})`
}

export function extensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("m4a")) return "m4a"
  return "webm"
}

export function isVariationRequest(message: string) {
  const lower = message.toLowerCase()
  const asksGenerate = lower.includes("generate") || lower.includes("create")
  const asksVariation = /variat/.test(lower)
  return asksGenerate && asksVariation
}

export function isComplexTaskRequest(message: string) {
  const trimmed = message.trim()
  if (trimmed.length === 0) return false
  const lower = trimmed.toLowerCase()
  const actionPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.actionKeywords.join("|")})\\b`, "g")
  const connectorPattern = new RegExp(`\\b(${COMPLEX_TASK_HEURISTICS.connectorKeywords.join("|")})\\b`, "g")
  const actionMatches = (lower.match(actionPattern) ?? []).length
  const connectorMatches = (lower.match(connectorPattern) ?? []).length
  const clauseMatches = (trimmed.match(/[,.!?;]/g) ?? []).length
  if (trimmed.length >= COMPLEX_TASK_HEURISTICS.minCharsForComplex) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithConnector && connectorMatches >= COMPLEX_TASK_HEURISTICS.minConnectorsForActionRule) return true
  if (actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsAny) return true
  return actionMatches >= COMPLEX_TASK_HEURISTICS.minActionsWithClauses && clauseMatches >= COMPLEX_TASK_HEURISTICS.minClausesForActionRule
}

export function mergedVariationProps(baseProps: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...baseProps, ...patch }
}

export function normalizeComparableText(value: string) {
  return value
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function comparableTokens(value: string) {
  const stopwords = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "to",
    "for",
    "of",
    "and",
    "with",
    "by",
    "from",
    "that",
    "this",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "it",
    "its",
    "selected",
    "block"
  ])
  return normalizeComparableText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !stopwords.has(token))
}

export function isRedundantChangeLine(summary: string | undefined, line: string) {
  const summaryNorm = normalizeComparableText(summary ?? "")
  const lineNorm = normalizeComparableText(line)
  if (!summaryNorm || !lineNorm) return false
  if (lineNorm === summaryNorm || lineNorm.includes(summaryNorm) || summaryNorm.includes(lineNorm)) return true

  const summaryTokens = new Set(comparableTokens(summaryNorm))
  const lineTokens = new Set(comparableTokens(lineNorm))
  if (summaryTokens.size === 0 || lineTokens.size === 0) return false

  let overlap = 0
  for (const token of lineTokens) {
    if (summaryTokens.has(token)) overlap += 1
  }

  const coverLine = overlap / lineTokens.size
  const coverSummary = overlap / summaryTokens.size
  return coverLine >= 0.55 || coverSummary >= 0.55
}

export function splitAiInsightChanges(lines: string[] | undefined) {
  const raw = Array.isArray(lines) ? lines : []
  let aiJustification: string | undefined
  let aiPerformanceNote: string | undefined
  const changes: string[] = []

  for (const line of raw) {
    if (typeof line !== "string") continue
    if (line.startsWith(AI_JUSTIFICATION_PREFIX)) {
      const value = line.slice(AI_JUSTIFICATION_PREFIX.length).trim()
      if (value) aiJustification = value
      continue
    }
    if (line.startsWith(AI_PERFORMANCE_PREFIX)) {
      const value = line.slice(AI_PERFORMANCE_PREFIX.length).trim()
      if (value) aiPerformanceNote = value
      continue
    }
    changes.push(line)
  }

  return { changes, aiJustification, aiPerformanceNote }
}
