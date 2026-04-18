import type { FastifyBaseLogger } from "fastify"
import {
  CancelError as _CancelError,
  isCancelError as _isCancelError
} from "../errors.js"
import { toErrorDetail } from "../ops/ops-engine.js"
import {
  versions,
  getSessionDraft,
  getPage,
  orderSlugsHomeFirst,
  getContextCache,
  setContextCache
} from "../state/session-state.js"
import type { createChatTelemetryStore } from "../telemetry/chat-telemetry.js"
import type { EvalCandidateStore } from "../telemetry/eval-candidate-store.js"
import type { AIProvider, ModelKey } from "../state/session-state.js"
import type { ToolRuntime } from "../tools/runtime.js"
import { normalizeVariationTypos } from "./chat-pipeline-translation.js"

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type ChatPipelineContext = {
  log: FastifyBaseLogger
  chatTelemetry: ReturnType<typeof createChatTelemetryStore>
  evalCandidates?: EvalCandidateStore
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
  toolRuntime: ToolRuntime
}

// ---------------------------------------------------------------------------
// Deferred image placeholder
// ---------------------------------------------------------------------------

/** Build a shimmer SVG data URI placeholder with a custom icon and label. */
function buildShimmerPlaceholder(icon: string, label: string): string {
  return [
    `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 600'%3E`,
    `%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='0'%3E`,
    `%3Cstop offset='0%25' stop-color='%23e2e8f0'/%3E`,
    `%3Cstop offset='50%25' stop-color='%23f1f5f9'%3E%3Canimate attributeName='offset' values='0;1;0' dur='2s' repeatCount='indefinite'/%3E%3C/stop%3E`,
    `%3Cstop offset='100%25' stop-color='%23e2e8f0'/%3E`,
    `%3C/linearGradient%3E%3C/defs%3E`,
    `%3Crect width='1200' height='600' fill='url(%23g)'/%3E`,
    icon,
    `%3Ctext x='616' y='310' text-anchor='middle' fill='%2394a3b8' font-family='system-ui' font-size='36' font-weight='500'%3E${label}%3C/text%3E`,
    `%3C/svg%3E`
  ].join("")
}

// AI sparkle icon — 4-point diamond star with companion sparkle
const SPARKLE_ICON = [
  `%3Cg transform='translate(448,296)' fill='%2394a3b8'%3E`,
  `%3Cpath d='M0-12C1 -4 4-1 12 0 4 1 1 4 0 12-1 4-4 1-12 0-4-1-1-4 0-12Z'%3E`,
  `%3Canimate attributeName='opacity' values='0.5;1;0.5' dur='2s' repeatCount='indefinite'/%3E%3C/path%3E`,
  `%3Cpath d='M11-9C11.4-7 12.6-5.8 15-5.5 12.6-5.2 11.4-4 11-2 10.6-4 9.4-5.2 7-5.5 9.4-5.8 10.6-7 11-9Z' opacity='0.6'%3E`,
  `%3Canimate attributeName='opacity' values='0.3;0.8;0.3' dur='1.6s' repeatCount='indefinite'/%3E%3C/path%3E`,
  `%3C/g%3E`
].join("")

// Magnifying glass icon
const SEARCH_ICON = [
  `%3Cg transform='translate(460,280)' fill='none' stroke='%2394a3b8' stroke-width='3'%3E`,
  `%3Ccircle cx='0' cy='0' r='10'%3E%3Canimate attributeName='opacity' values='0.4;1;0.4' dur='1.8s' repeatCount='indefinite'/%3E%3C/circle%3E`,
  `%3Cline x1='7' y1='7' x2='14' y2='14'%3E%3Canimate attributeName='opacity' values='0.4;1;0.4' dur='1.8s' repeatCount='indefinite'/%3E%3C/line%3E`,
  `%3C/g%3E`
].join("")

export const GENERATING_IMAGE_PLACEHOLDER = buildShimmerPlaceholder(SPARKLE_ICON, "Generating image%E2%80%A6")
export const SEARCHING_IMAGE_PLACEHOLDER = buildShimmerPlaceholder(SEARCH_ICON, "Searching%E2%80%A6")

/** Returns true if the URL is a shimmer placeholder used during deferred image generation/search. */
/**
 * A native image tool call deferred during planning so text ops stream
 * immediately. The real tool is executed post-apply and the result is
 * patched into the preview via follow-up SSE events.
 */
export type DeferredNativeImageCall = {
  toolName: "image.generate" | "unsplash.search"
  input: Record<string, unknown>
  placeholderUrl: string
}

/** Tool names whose execution is deferred to avoid blocking text streaming */
export const DEFERRABLE_IMAGE_TOOLS = new Set(["image.generate", "unsplash.search"])

export function isGeneratingPlaceholder(url: string): boolean {
  if (url.startsWith("data:image/svg+xml,") && (url.includes("Generating%20image") || url.includes("Generating image") || url.includes("Searching"))) return true
  if (url.includes("placehold.co") && (url.includes("Generating") || url.includes("Searching"))) return true
  return false
}

/**
 * Recursively walk an object and clear any string values that match the
 * generating-image placeholder.  Handles nested arrays (e.g. `cards[i].imageUrl`,
 * `images[i].imageUrl`) and arbitrary prop depth.
 */
function clearPlaceholdersDeep(obj: unknown): number {
  if (obj === null || obj === undefined || typeof obj !== "object") return 0
  let count = 0
  if (Array.isArray(obj)) {
    for (const item of obj) { count += clearPlaceholdersDeep(item) }
    return count
  }
  const record = obj as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const val = record[key]
    if (typeof val === "string" && isGeneratingPlaceholder(val)) {
      record[key] = ""
      count += 1
    } else if (typeof val === "object" && val !== null) {
      count += clearPlaceholdersDeep(val)
    }
  }
  return count
}

/** Remove any "Generating image..." SVG placeholders left in session state (e.g. after cancel). */
export function cleanupImagePlaceholders(session: string): number {
  const draft = getSessionDraft(session)
  let total = 0
  for (const [, page] of draft) {
    for (const block of page.blocks) {
      total += clearPlaceholdersDeep(block.props)
    }
  }
  return total
}

/** Metadata for a deferred create_page Hero image that still needs resolution. */
export type DeferredCreatePageImage = {
  pageSlug: string
  blockId: string
  query: string
  pageTitle: string
  sectionContext: string
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Build a compact page directory from the session draft for the system prompt.
 *  Results are cached per session and invalidated when pages change. */
export function buildPageDirectory(session: string): string {
  const cached = getContextCache(session)
  const currentVersion = versions.get(session) ?? 0
  if (cached && cached.version === currentVersion && typeof cached.pageDirectory === "string") {
    return cached.pageDirectory
  }
  const draft = getSessionDraft(session)
  if (draft.size === 0) return ""
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  const result = slugs
    .map((slug) => {
      const page = draft.get(slug)!
      const blockTypes = page.blocks.map((b) => b.type).join(", ")
      return `  ${slug} "${page.title}" (${blockTypes})`
    })
    .join("\n")
  setContextCache(session, { version: currentVersion, pageDirectory: result })
  return result
}

export function isVariationRequestMessage(message: string) {
  const normalized = normalizeVariationTypos(message.toLowerCase())
  return (
    /\b(variations?|alternatives?|variants?|options)\b/.test(normalized) &&
    /\b(generate|create|make|show|give|produce|draft)\b/.test(normalized)
  )
}

// ---------------------------------------------------------------------------
// Effective slug resolution
// ---------------------------------------------------------------------------

export function resolveEffectiveSlug(args: { session: string; requestedSlug: string; activeBlockId?: string }) {
  const { session, requestedSlug, activeBlockId } = args
  if (!activeBlockId) return requestedSlug
  const current = getPage(session, requestedSlug)
  if (current?.blocks.some((block) => block.id === activeBlockId)) return requestedSlug
  const draft = getSessionDraft(session)
  for (const [slug, page] of draft) {
    if (page.blocks.some((block) => block.id === activeBlockId)) return slug
  }
  return requestedSlug
}

// ---------------------------------------------------------------------------
// Cancel error — re-exported from errors.ts for backward compatibility
// ---------------------------------------------------------------------------

export const CancelError = _CancelError
export const isCancelError = _isCancelError

export function throwIfCanceled(signal?: AbortSignal) {
  if (signal?.aborted) throw new _CancelError(signal.reason as string ?? "user_canceled")
}

/** Race a promise against an abort signal. Rejects with CancelError if signal fires first. */
export function raceCancel<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new _CancelError(signal.reason as string ?? "user_canceled"))
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new _CancelError(signal.reason as string ?? "user_canceled")), { once: true })
    })
  ])
}

// ---------------------------------------------------------------------------
// SSE write helper
// ---------------------------------------------------------------------------

/** Parse "Suggested next actions:" bullet list from summary text. */
export function parseSuggestionsFromSummary(text: string): { summary: string; suggestions: string[] } {
  const marker = /\n*(?:suggested\s+(?:next\s+)?actions|next\s+steps|you\s+(?:could|might)\s+(?:also|want\s+to)):\s*\n/i
  const match = text.match(marker)
  if (!match || match.index === undefined) return { summary: text.trim(), suggestions: [] }
  const before = text.slice(0, match.index).trim()
  const after = text.slice(match.index + match[0].length)
  const suggestions = after
    .split("\n")
    .map(line => line.replace(/^[-•*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(line => line.length > 5 && line.length < 120)
    .slice(0, 4)
  return { summary: before, suggestions }
}

export function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  const stream = reply.raw as NodeJS.WritableStream & {
    destroyed?: boolean
    writableEnded?: boolean
    writable?: boolean
  }
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // Client disconnected; ignore write errors for SSE.
  }
}

export function sleepMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs))
}

/**
 * Suppress cancel errors on a promise but log any other errors at WARN.
 * Use instead of `.catch(() => {})` to avoid hiding real failures.
 */
export function suppressCancelOnly(promise: Promise<unknown>, log: FastifyBaseLogger, label: string) {
  promise.catch((err) => {
    if (!_isCancelError(err)) {
      log.warn({ event: "suppressed_non_cancel_error", label, error: toErrorDetail(err) }, `${label}: suppressed non-cancel error`)
    }
  })
}
