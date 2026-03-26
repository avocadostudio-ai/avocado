/**
 * Agent transport: sends chat through /agent/start + /agent/stream SSE
 * instead of the regular /chat pipeline. Used when the user provides
 * their own Anthropic API key.
 */

import { withAccessTokenQuery } from "../../lib/access-auth"
import type { AssistantResponse } from "../../lib/editor-types"

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
    setStreamStatus, setStreamSteps, applyChatResult, pushAssistantFromResult, postToSite, setActiveBlockId,
  } = args

  let eventSource: EventSource | null = null
  let canceled = false

  const cancel = () => {
    canceled = true
    eventSource?.close()
    setStreamStatus(null)
    setStreamSteps([])
  }

  const promise = (async (): Promise<boolean> => {
  setStreamStatus("Agent thinking...")
  setStreamSteps([{ label: "Starting agent", done: false }])

  // Step 1: POST /agent/start to get streamId
  let streamId: string
  try {
    const res = await fetch(`${orchestrator}/agent/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-anthropic-api-key": agentApiKey,
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
  } catch {
    return false
  }

  if (canceled) return false

  // Step 2: Connect SSE to /agent/stream
  return await new Promise<boolean>((resolve) => {
    const source = new EventSource(withAccessTokenQuery(`${orchestrator}/agent/stream?streamId=${streamId}`))
    eventSource = source
    let settled = false
    let summaryText = ""

    source.onmessage = (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as Record<string, unknown>
        const type = d.type as string

        if (type === "status") {
          const msg = d.message as string
          setStreamStatus(msg)
          setStreamSteps((prev) => {
            const done = prev.map((s) => ({ ...s, done: true }))
            return [...done, { label: msg.replace(/\.\.\.$/, ""), done: false }]
          })
        } else if (type === "summary_token") {
          summaryText += d.text as string
          setStreamStatus("Agent responding...")
        } else if (type === "op_applied") {
          const focusBlockId = d.focusBlockId as string | undefined
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
          settled = true
          const result = d.result as Record<string, unknown>
          const summary = (result.summary as string) || summaryText
          const suggestions = Array.isArray(result.suggestions) ? result.suggestions as string[] : []
          setStreamStatus(null)
          setStreamSteps([])
          applyChatResult({
            status: "applied",
            summary,
            changes: [],
            suggestions,
            previewVersion: result.previewVersion as number | undefined,
            focusBlockId: result.focusBlockId as string | undefined,
          })
          // Refresh preview with latest state
          postToSite("draftUpdated", { focusBlockId: result.focusBlockId ?? undefined })
          source.close()
          resolve(true)
        } else if (type === "error") {
          settled = true
          const result = d.result as Record<string, unknown>
          setStreamStatus(null)
          setStreamSteps([])
          pushAssistantFromResult({
            status: "error",
            summary: (result.summary as string) || "Agent error",
            changes: [],
          })
          source.close()
          resolve(false)
        }
      } catch { /* ignore unparseable */ }
    }

    source.onerror = () => {
      if (!settled) {
        setStreamStatus(null)
        setStreamSteps([])
        pushAssistantFromResult({
          status: "error",
          summary: "Agent connection lost",
          changes: [],
        })
        resolve(false)
      }
      source.close()
    }
  })
  })()

  return { promise, cancel }
}
