import type { PreviewWidthPreset } from "./editor-types"

export const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
export const AI_PERFORMANCE_PREFIX = "__ai_performance__:"
export const DEBUG_MODE_STORAGE_KEY = "editor-debug-mode-v1"
export const MODEL_KEY_STORAGE_KEY = "editor-model-key-v1"
export const PROVIDER_STORAGE_KEY = "editor-provider-v1"
export const CHAT_THEME_STORAGE_KEY = "editor-chat-theme-v1"

export const previewPresetWidths: Record<PreviewWidthPreset, number> = {
  desktop: 1200,
  tablet: 834,
  mobile: 390
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
const VALID_PROVIDERS = new Set<string>(["openai", "anthropic", "gemini"])

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

export function resolveDefaultChatDarkMode() {
  if (typeof window === "undefined") return false
  const stored = window.sessionStorage.getItem(CHAT_THEME_STORAGE_KEY) ?? window.localStorage.getItem(CHAT_THEME_STORAGE_KEY)
  if (stored === "dark") return true
  if (stored === "light") return false
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false
}

export const ANCHORED_COMPOSER_STORAGE_KEY = "editor-anchored-composer-v1"

export function resolveAnchoredComposerEnabled() {
  // env override takes priority
  const envVal = (import.meta.env.VITE_ANCHORED_COMPOSER as string | undefined) ?? ""
  if (/^(0|false|no|off)$/i.test(envVal)) return false
  if (/^(1|true|yes|on)$/i.test(envVal)) return true
  // fall back to localStorage, default on
  if (typeof window === "undefined") return true
  const stored = window.localStorage.getItem(ANCHORED_COMPOSER_STORAGE_KEY)
  if (stored === "0" || stored === "false") return false
  return true
}

export function mergedVariationProps(baseProps: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...baseProps, ...patch }
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
