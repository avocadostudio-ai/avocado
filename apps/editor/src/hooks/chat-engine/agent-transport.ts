/**
 * Agent transport: sends chat through /agent/start + /agent/stream SSE
 * instead of the regular /chat pipeline. Used when the user provides
 * their own Anthropic API key.
 */

import { withAccessTokenQuery } from "../../lib/access-auth"
import type { AssistantResponse } from "../../lib/editor-types"
import { toPastTense } from "../../lib/utils"

type AgentTransportArgs = {
  orchestrator: string
  agentApiKey: string
  session: string
  siteId: string
  slug: string
  message: string
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  locale?: string
  sitePurpose?: string
  setStreamStatus: (value: string | null) => void
  setStreamSteps: (value: { label: string; done: boolean }[] | ((prev: { label: string; done: boolean }[]) => { label: string; done: boolean }[])) => void
  setStreamingText: (value: string | null | ((prev: string | null) => string | null)) => void
  setStreamingChanges: (value: string[] | ((prev: string[]) => string[])) => void
  setLatestStreamFocusBlockId: (value: string | null) => void
  applyChatResult: (data: AssistantResponse) => void
  pushAssistantFromResult: (data: AssistantResponse) => void
  postToSite: (type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading", payload: Record<string, unknown>) => void
  setActiveBlockId: (id: string | undefined) => void
}

export type AgentStreamHandle = {
  promise: Promise<boolean>
  cancel: () => void
}

export function submitAgentStream(args: AgentTransportArgs): AgentStreamHandle {
  const {
    orchestrator, agentApiKey, session, siteId, slug, message,
    activeBlockId, activeBlockType, activeEditablePath, locale, sitePurpose,
    setStreamStatus, setStreamSteps, setStreamingText, setStreamingChanges, setLatestStreamFocusBlockId,
    applyChatResult, pushAssistantFromResult, postToSite, setActiveBlockId,
  } = args

  let eventSource: EventSource | null = null
  let canceled = false
  let activeStreamId: string | null = null
  let settleFromOutside: ((ok: boolean) => void) | null = null
  const MAX_RECONNECT_ATTEMPTS = 4
  const RECONNECT_DELAY_MS = 700
  const IDLE_HEARTBEAT_MS = 15_000
  const MAX_STREAM_DURATION_MS = 180_000

  const cancel = () => {
    canceled = true
    eventSource?.close()
    setStreamStatus(null)
    setStreamSteps([])
    setStreamingText(null)
    setStreamingChanges([])
    setLatestStreamFocusBlockId(null)
    // Tell server to abort the agent loop (fire-and-forget)
    if (activeStreamId) {
      fetch(`${orchestrator}/agent/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: activeStreamId }),
      }).catch(() => {})
    }
    settleFromOutside?.(true)
  }

  const promise = (async (): Promise<boolean> => {
  setStreamStatus("Agent thinking...")
  setStreamSteps([])

  // Activate shimmer immediately on the active block while agent thinks
  if (activeBlockId) {
    postToSite("aiFieldLoading", { blockId: activeBlockId, active: true })
  }

  // Step 1: POST /agent/start to get streamId
  let streamId: string
  try {
    const res = await fetch(`${orchestrator}/agent/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-api-key": agentApiKey,
      },
      body: JSON.stringify({
        session, siteId, slug, message,
        activeBlockId, activeBlockType, activeEditablePath,
        locale, sitePurpose,
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Status ${res.status}` }))
      pushAssistantFromResult({ status: "error", summary: (err as { error?: string }).error ?? "Agent start failed", changes: [] })
      return false
    }
    const data = await res.json() as { streamId?: string }
    if (!data.streamId) return false
    streamId = data.streamId
    activeStreamId = streamId
  } catch {
    return canceled ? true : false
  }

  if (canceled) return true

  // Step 2: Connect SSE to /agent/stream
  return await new Promise<boolean>((resolve) => {
    let settled = false
    let summaryText = ""
    let lastFocusBlockId = activeBlockId ?? ""
    let gotAnyEvent = false
    let lastSeq = 0
    let reconnectAttempts = 0
    let reconnectTimer: number | null = null
    let heartbeatWatchdogTimer: number | null = null
    let hardTimeoutTimer: number | null = null
    let lastEventAt = Date.now()

    const clearStreamUi = () => {
      setStreamStatus(null)
      setStreamSteps([])
      setStreamingText(null)
      setStreamingChanges([])
      setLatestStreamFocusBlockId(null)
    }

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const clearHeartbeatWatchdog = () => {
      if (heartbeatWatchdogTimer === null) return
      window.clearInterval(heartbeatWatchdogTimer)
      heartbeatWatchdogTimer = null
    }

    const clearHardTimeout = () => {
      if (hardTimeoutTimer === null) return
      window.clearTimeout(hardTimeoutTimer)
      hardTimeoutTimer = null
    }

    const keepShimmerAlive = () => {
      if (lastFocusBlockId && !canceled) {
        postToSite("aiFieldLoading", { blockId: lastFocusBlockId, active: true })
      }
    }

    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      settleFromOutside = null
      clearReconnectTimer()
      clearHeartbeatWatchdog()
      clearHardTimeout()
      eventSource?.close()
      eventSource = null
      resolve(ok)
    }
    settleFromOutside = settle

    const scheduleReconnect = () => {
      if (settled || canceled) return
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        clearStreamUi()
        pushAssistantFromResult({
          status: "error",
          summary: "Agent connection lost",
          changes: [],
        })
        settle(false)
        return
      }
      reconnectAttempts += 1
      setStreamStatus(`Reconnecting agent stream (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
      clearReconnectTimer()
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        if (settled || canceled) return
        connect(lastSeq > 0 ? lastSeq : undefined)
      }, RECONNECT_DELAY_MS)
    }

    const startHeartbeatWatchdog = () => {
      clearHeartbeatWatchdog()
      heartbeatWatchdogTimer = window.setInterval(() => {
        if (settled || canceled) return
        const idleMs = Date.now() - lastEventAt
        if (idleMs < IDLE_HEARTBEAT_MS) return
        const idleSec = Math.floor(idleMs / 1000)
        setStreamStatus(`Agent still thinking… ${idleSec}s`)
        keepShimmerAlive()
      }, 4000)
    }

    const startHardTimeout = () => {
      clearHardTimeout()
      hardTimeoutTimer = window.setTimeout(() => {
        if (settled || canceled) return
        clearStreamUi()
        pushAssistantFromResult({
          status: "error",
          summary: "Agent timed out. Please try again.",
          changes: [],
        })
        settle(false)
      }, MAX_STREAM_DURATION_MS)
    }

    const onMessage = (e: MessageEvent) => {
      let d: Record<string, unknown>
      try {
        d = JSON.parse(e.data) as Record<string, unknown>
      } catch {
        return
      }

      gotAnyEvent = true
      lastEventAt = Date.now()
      reconnectAttempts = 0

      const seq = Number(d._seq)
      if (Number.isFinite(seq) && seq > lastSeq) lastSeq = seq

      const type = d.type as string
      if (type === "status") {
        const msg = d.message as string
        setStreamStatus(msg)
        setStreamSteps((prev) => {
          const done = prev.map((s) => s.done ? s : { ...s, label: toPastTense(s.label), done: true })
          return [...done, { label: msg.replace(/\.\.\.$/, ""), done: false }]
        })
        keepShimmerAlive()
      } else if (type === "heartbeat") {
        const stage = typeof d.stage === "string" ? d.stage : "thinking"
        const elapsedMs = Number(d.elapsedMs ?? 0)
        const elapsedSec = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0
        const label =
          stage === "tool" ? "Agent using tools" :
          stage === "responding" ? "Agent responding" :
          stage === "applying" ? "Applying changes" :
          "Agent thinking"
        setStreamStatus(`${label}… ${elapsedSec}s`)
        keepShimmerAlive()
      } else if (type === "summary_token") {
        summaryText += d.text as string
        setStreamingText((prev) => (prev ?? "") + (d.text as string))
        setStreamStatus("Agent responding...")
      } else if (type === "changelog_entry") {
        const entry = d.entry as string
        if (entry) setStreamingChanges((prev) => [...prev, entry])
      } else if (type === "op_applied") {
        const focusBlockId = d.focusBlockId as string | undefined
        if (focusBlockId) {
          lastFocusBlockId = focusBlockId
          setLatestStreamFocusBlockId(focusBlockId)
        }
        setStreamSteps((prev) => {
          const done = prev.map((s) => ({ ...s, done: true }))
          return [...done, { label: `Applied ${d.toolName}`, done: true }]
        })
        // Refresh preview
        postToSite("draftUpdated", { focusBlockId })
        // Re-apply shimmer after preview re-renders the block DOM
        if (focusBlockId) {
          setTimeout(() => {
            if (!canceled) {
              postToSite("aiFieldLoading", { blockId: focusBlockId, active: true })
            }
          }, 350)
        }
      } else if (type === "tool_error") {
        setStreamSteps((prev) => [...prev, { label: `Error: ${d.toolName}`, done: true }])
      } else if (type === "final") {
        const result = d.result as Record<string, unknown>
        const summary = (result.summary as string) || summaryText
        const suggestions = Array.isArray(result.suggestions) ? result.suggestions as string[] : []
        clearStreamUi()
        // Parse variation data if present
        const vr = result.variations as Record<string, unknown> | undefined
        const variations = vr && Array.isArray(vr.variations) ? {
          blockId: vr.blockId as string,
          blockType: vr.blockType as string,
          pageSlug: vr.pageSlug as string,
          baseProps: (vr.baseProps ?? {}) as Record<string, unknown>,
          options: vr.variations as { id: string; title: string; summary: string; patch: Record<string, unknown>; changedKeys: string[] }[],
        } : undefined
        applyChatResult({
          status: "applied",
          summary,
          changes: [],
          suggestions,
          variations,
          previewVersion: result.previewVersion as number | undefined,
          focusBlockId: result.focusBlockId as string | undefined,
        })
        // Refresh preview with latest state
        postToSite("draftUpdated", { focusBlockId: result.focusBlockId ?? undefined })
        settle(true)
      } else if (type === "error") {
        const result = d.result as Record<string, unknown>
        const summary = (result.summary as string) || "Agent error"
        clearStreamUi()
        if (canceled || /canceled by user/i.test(summary)) {
          settle(true)
          return
        }
        pushAssistantFromResult({
          status: "error",
          summary,
          changes: [],
        })
        settle(false)
      }
    }

    const onError = () => {
      eventSource?.close()
      eventSource = null
      if (settled) return
      if (canceled) {
        clearStreamUi()
        settle(true)
        return
      }
      if (gotAnyEvent && lastSeq > 0) {
        scheduleReconnect()
        return
      }
      clearStreamUi()
      pushAssistantFromResult({
        status: "error",
        summary: "Agent connection lost",
        changes: [],
      })
      settle(false)
    }

    const connect = (afterSeq?: number) => {
      const reconnectPart = afterSeq && afterSeq > 0 ? `&afterSeq=${afterSeq}` : ""
      const source = new EventSource(withAccessTokenQuery(`${orchestrator}/agent/stream?streamId=${streamId}${reconnectPart}`))
      eventSource = source
      source.onmessage = onMessage
      source.onerror = onError
    }
    startHeartbeatWatchdog()
    startHardTimeout()
    connect()
  })
  })()

  return { promise, cancel }
}
