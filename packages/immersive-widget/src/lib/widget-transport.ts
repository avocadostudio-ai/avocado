/**
 * Chat transport for the immersive widget.
 * Talks directly to the orchestrator via HTTP + SSE — no postMessage middleman.
 */

import type { BlockManifest } from "@ai-site-editor/shared"
import { getAccessToken } from "./access-auth"

export type ChatRequestPayload = {
  session: string
  siteId: string
  slug: string
  message: string
  modelKey: string
  provider: string
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

type StreamEvent =
  | { type: "status"; message: string }
  | { type: "op_applied"; index: number; total: number; previewVersion: number; focusBlockId?: string; updatedSlug?: string }
  | { type: "field_draft"; blockId: string; editablePath: string; value: string }
  | { type: "final"; result: ChatResult }
  | { type: "error"; result: ChatResult }
  | { type: "heartbeat"; stage: string; label: string }
  | { type: "canceled"; message: string }

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
        try {
          const d = JSON.parse(e.data) as Record<string, unknown>
          const type = d.type as string

          if (type === "status") {
            callbacks.onStatus?.(d.message as string)
          } else if (type === "heartbeat") {
            callbacks.onStatus?.(d.label as string)
          } else if (type === "op_applied") {
            callbacks.onOpApplied?.(d as unknown as { index: number; total: number; previewVersion: number; focusBlockId?: string; updatedSlug?: string })
          } else if (type === "field_draft") {
            callbacks.onFieldDraft?.(d as unknown as { blockId: string; editablePath: string; value: string })
          } else if (type === "summary_token") {
            // Could display incremental summary text — for now just show status
            callbacks.onStatus?.("Generating response...")
          } else if (type === "final") {
            settled = true
            const result = (d.result ?? d) as ChatResult
            callbacks.onFinal?.(result)
            source?.close()
          } else if (type === "error") {
            settled = true
            const result = (d.result ?? d) as ChatResult
            callbacks.onError?.(result)
            source?.close()
          } else if (type === "canceled") {
            settled = true
            source?.close()
          }
        } catch { /* ignore unparseable frames */ }
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
