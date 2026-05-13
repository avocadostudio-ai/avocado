/**
 * Chat transport for the immersive widget.
 * Talks directly to the orchestrator via HTTP + SSE — no postMessage middleman.
 */

import type { BlockManifest, ChatStreamEvent } from "@avocadostudio-ai/shared"
import { parseChatStreamFrame } from "@avocadostudio-ai/shared"
import { getAccessToken } from "./access-auth"

export type ChatRequestPayload = {
  session: string
  siteId: string
  slug: string
  message: string
  locale?: string
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  selectedText?: string
  componentsManifest?: BlockManifest | null
  siteCapabilities?: { allowStructuralEdits?: boolean; manifestStatus?: string; blockCount?: number }
  sitePurpose?: string
  businessContext?: { purpose?: string; tone?: string; constraints?: string[] }
  siteContext?: { siteId: string; siteName?: string; purpose?: string; tone?: string; constraints?: string[] }
}

/**
 * Apply operations directly via /ops endpoint (for block reorder, delete, add, etc.)
 */
export async function applyOps(
  orchestratorUrl: string,
  payload: { session: string; siteId: string; ops: Record<string, unknown>[] },
): Promise<{ ok: boolean; previewVersion?: number; error?: string }> {
  const token = getAccessToken()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["x-access-token"] = token

  try {
    const res = await fetch(`${orchestratorUrl}/ops`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data.error ?? `Status ${res.status}` }
    return { ok: true, previewVersion: data.previewVersion }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export type HistoryStatus = { canUndo: boolean; canRedo: boolean }
export type HistoryResult = {
  ok: boolean
  error?: string
  previewVersion?: number
  canUndo?: boolean
  canRedo?: boolean
  navigateToSlug?: string
}

export async function fetchHistoryStatus(
  orchestratorUrl: string,
  args: { session: string; siteId: string; slug: string },
): Promise<HistoryStatus> {
  const token = getAccessToken()
  const headers: Record<string, string> = {}
  if (token) headers["x-access-token"] = token
  const url = `${orchestratorUrl}/history/status?session=${encodeURIComponent(args.session)}&siteId=${encodeURIComponent(args.siteId)}&slug=${encodeURIComponent(args.slug)}`
  try {
    const res = await fetch(url, { headers })
    if (!res.ok) return { canUndo: false, canRedo: false }
    const data = await res.json() as HistoryStatus
    return { canUndo: !!data.canUndo, canRedo: !!data.canRedo }
  } catch {
    return { canUndo: false, canRedo: false }
  }
}

async function postHistory(
  orchestratorUrl: string,
  action: "undo" | "redo",
  args: { session: string; siteId: string; slug: string },
): Promise<HistoryResult> {
  const token = getAccessToken()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["x-access-token"] = token
  try {
    const res = await fetch(`${orchestratorUrl}/history/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, error: data?.error ?? `Status ${res.status}` }
    return {
      ok: true,
      previewVersion: data.previewVersion,
      canUndo: !!data.canUndo,
      canRedo: !!data.canRedo,
      navigateToSlug: data.navigateToSlug,
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export const applyHistoryUndo = (url: string, args: { session: string; siteId: string; slug: string }) =>
  postHistory(url, "undo", args)
export const applyHistoryRedo = (url: string, args: { session: string; siteId: string; slug: string }) =>
  postHistory(url, "redo", args)

export type ChatResult = {
  status: string
  summary: string
  changes: string[]
  suggestions?: string[]
  previewVersion?: number
  focusBlockId?: string
  updatedSlug?: string
  error?: string
}

export type StreamCallbacks = {
  onStatus?: (message: string) => void
  onOpApplied?: (event: { index: number; total: number; previewVersion: number; focusBlockId?: string; updatedSlug?: string }) => void
  onFieldDraft?: (event: { blockId: string; editablePath: string; value: string }) => void
  onFinal?: (result: ChatResult) => void
  onError?: (result: ChatResult) => void
}

/**
 * Submit a chat message via HTTP POST (blocking, returns full result).
 */
export async function submitChatHttp(
  orchestratorUrl: string,
  payload: ChatRequestPayload,
  accessToken?: string,
): Promise<ChatResult> {
  const token = accessToken || getAccessToken()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers["x-access-token"] = token

  const res = await fetch(`${orchestratorUrl}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    return { status: "error", summary: `Request failed: ${res.status}`, changes: [] }
  }

  return (await res.json()) as ChatResult
}

/**
 * Submit a chat message via SSE stream for real-time updates.
 * Returns a cancel function.
 */
export function submitChatStream(
  orchestratorUrl: string,
  payload: ChatRequestPayload,
  callbacks: StreamCallbacks,
  accessToken?: string,
): { cancel: () => void; ready: Promise<boolean> } {
  let source: EventSource | null = null
  let canceled = false
  const token = accessToken || getAccessToken()

  const ready = (async () => {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (token) headers["x-access-token"] = token

      const res = await fetch(`${orchestratorUrl}/chat/start`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })

      if (!res.ok || canceled) {
        if (res.status === 401) {
          callbacks.onError?.({ status: "error", summary: "Unauthorized", changes: [] })
        } else if (!canceled) {
          callbacks.onError?.({ status: "error", summary: `Request failed: ${res.status}`, changes: [] })
        }
        return false
      }
      const data = (await res.json()) as { streamId?: string }
      if (!data.streamId || canceled) return false

      const streamUrl = token
        ? `${orchestratorUrl}/chat/stream?streamId=${data.streamId}&accessToken=${encodeURIComponent(token)}`
        : `${orchestratorUrl}/chat/stream?streamId=${data.streamId}`

      source = new EventSource(streamUrl)
      let settled = false

      // The orchestrator sends plain `data:` lines (no `event:` prefix).
      // All events arrive through the generic `onmessage` handler.
      source.onmessage = (e: MessageEvent) => {
        let raw: unknown
        try {
          raw = JSON.parse(e.data)
        } catch {
          return
        }
        const frame = parseChatStreamFrame(raw)
        if (!frame) return
        const event: ChatStreamEvent = frame

        switch (event.type) {
          case "status":
            callbacks.onStatus?.(event.message)
            break
          case "heartbeat":
            callbacks.onStatus?.(event.label)
            break
          case "op_applied":
            callbacks.onOpApplied?.({
              index: event.index,
              total: event.total,
              previewVersion: event.previewVersion,
              focusBlockId: event.focusBlockId ?? undefined,
              updatedSlug: event.updatedSlug,
            })
            break
          case "field_draft":
            callbacks.onFieldDraft?.({
              blockId: event.blockId,
              editablePath: event.editablePath,
              value: event.value,
            })
            break
          case "summary_token":
            callbacks.onStatus?.("Generating response...")
            break
          case "final":
            settled = true
            callbacks.onFinal?.(event.result as ChatResult)
            source?.close()
            break
          case "error":
            settled = true
            callbacks.onError?.((event.result ?? { status: "error", summary: "Error", changes: [] }) as ChatResult)
            source?.close()
            break
          case "canceled":
            settled = true
            source?.close()
            break
          default:
            // Unhandled event types (op_candidate, plan_meta, rollback_*, image_progress, token, changelog_entry, op_skipped) — ignored for now
            break
        }
      }

      source.onerror = () => {
        if (!settled && !canceled) {
          callbacks.onError?.({ status: "error", summary: "Connection lost", changes: [] })
        }
        source?.close()
      }

      return true
    } catch {
      return false
    }
  })()

  return {
    cancel: () => {
      canceled = true
      source?.close()
    },
    ready,
  }
}
