/**
 * Hook for the sites-page chat agent.
 * Manages messages, streaming state, and SSE connection to /sites-agent/*.
 *
 * Session-resilient: messages persist to sessionStorage, and an active stream
 * can be reconnected after page reload (the server buffers events).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { orchestrator } from "../lib/site-urls"
import { withAccessTokenQuery } from "../lib/access-auth"
import type { SiteConfig } from "../lib/editor-types"

export type SitesAgentMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp: number
}

export type UseSitesAgentReturn = {
  messages: SitesAgentMessage[]
  isStreaming: boolean
  streamStatus: string | null
  streamSteps: { label: string; done: boolean; count?: number }[]
  streamingText: string | null
  sendMessage: (text: string) => void
  cancelStream: () => void
  clearMessages: () => void
}

const STORAGE_KEY = "sites-agent-messages"
const STREAM_KEY = "sites-agent-stream"

let msgCounter = 0
function nextId() { return `sa_${++msgCounter}_${Date.now()}` }

function loadMessages(): SitesAgentMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveMessages(msgs: SitesAgentMessage[]) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(msgs)) } catch { /* full */ }
}

function loadStreamState(): { streamId: string; lastSeq: number } | null {
  try {
    const raw = sessionStorage.getItem(STREAM_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveStreamState(streamId: string, lastSeq: number) {
  try { sessionStorage.setItem(STREAM_KEY, JSON.stringify({ streamId, lastSeq })) } catch { /* */ }
}

function clearStreamState() {
  try { sessionStorage.removeItem(STREAM_KEY) } catch { /* */ }
}

export function useSitesAgent(options: {
  session: string
  locale?: string
  onSiteCreated?: (config: SiteConfig) => void
}): UseSitesAgentReturn {
  const { session, locale, onSiteCreated } = options

  const [messages, setMessages] = useState<SitesAgentMessage[]>(loadMessages)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamSteps, setStreamSteps] = useState<{ label: string; done: boolean; count?: number }[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)

  const activeStreamId = useRef<string | null>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const lastSeqRef = useRef(0)
  const summaryTextRef = useRef("")
  const onSiteCreatedRef = useRef(onSiteCreated)
  onSiteCreatedRef.current = onSiteCreated

  // Persist messages to sessionStorage whenever they change
  useEffect(() => { saveMessages(messages) }, [messages])

  // Connect to an SSE stream (new or reconnect)
  const connectToStream = useCallback((streamId: string, afterSeq: number) => {
    activeStreamId.current = streamId
    lastSeqRef.current = afterSeq
    setIsStreaming(true)
    setStreamStatus("Connecting...")

    const url = withAccessTokenQuery(
      `${orchestrator}/sites-agent/stream?streamId=${streamId}${afterSeq > 0 ? `&afterSeq=${afterSeq}` : ""}`
    )
    const source = new EventSource(url)
    eventSourceRef.current = source

    source.onmessage = (e) => {
      let d: Record<string, unknown>
      try { d = JSON.parse(e.data) } catch { return }

      // Track sequence for reconnection
      if (typeof d._seq === "number") {
        lastSeqRef.current = d._seq as number
        saveStreamState(streamId, lastSeqRef.current)
      }

      const type = d.type as string

      if (type === "status") {
        const msg = d.message as string
        setStreamStatus(msg)
        const label = msg.replace(/\.\.\.$/, "")
        setStreamSteps(prev => {
          const done = prev.map(s => ({ ...s, done: true }))
          if (done.length > 0 && done[done.length - 1].label === label) {
            const last = done[done.length - 1]
            done[done.length - 1] = { ...last, count: (last.count ?? 1) + 1 }
            return [...done, { label, done: false }]
          }
          return [...done, { label, done: false }]
        })
      } else if (type === "heartbeat") {
        const elapsedMs = Number(d.elapsedMs ?? 0)
        const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000))
        setStreamStatus(`Agent working... ${elapsedSec}s`)
      } else if (type === "summary_token") {
        summaryTextRef.current += d.text as string
        setStreamingText(prev => (prev ?? "") + (d.text as string))
        setStreamStatus("Agent responding...")
      } else if (type === "site_created") {
        const config = d.config as SiteConfig
        if (config && onSiteCreatedRef.current) onSiteCreatedRef.current(config)
      } else if (type === "final") {
        const result = d.result as Record<string, unknown>
        const summary = (result.summary as string) || summaryTextRef.current
        if (summary) {
          const assistantMsg: SitesAgentMessage = { id: nextId(), role: "assistant", text: summary, timestamp: Date.now() }
          setMessages(prev => [...prev, assistantMsg])
        }

        const sitesCreated = result.sitesCreated as Array<Record<string, unknown>> | undefined
        if (sitesCreated && onSiteCreatedRef.current) {
          for (const config of sitesCreated) {
            onSiteCreatedRef.current(config as SiteConfig)
          }
        }

        source.close()
        eventSourceRef.current = null
        activeStreamId.current = null
        summaryTextRef.current = ""
        clearStreamState()
        setIsStreaming(false)
        setStreamStatus(null)
        setStreamSteps([])
        setStreamingText(null)
      } else if (type === "error") {
        const result = d.result as Record<string, unknown>
        const summary = (result.summary as string) || "Agent error"
        const errMsg: SitesAgentMessage = { id: nextId(), role: "assistant", text: summary, timestamp: Date.now() }
        setMessages(prev => [...prev, errMsg])
        source.close()
        eventSourceRef.current = null
        activeStreamId.current = null
        summaryTextRef.current = ""
        clearStreamState()
        setIsStreaming(false)
        setStreamStatus(null)
        setStreamSteps([])
        setStreamingText(null)
      }
    }

    source.onerror = () => {
      source.close()
      eventSourceRef.current = null
      if (!activeStreamId.current) return
      activeStreamId.current = null
      clearStreamState()
      setIsStreaming(false)
      setStreamStatus(null)
      setStreamSteps([])
      setStreamingText(null)
      if (summaryTextRef.current) {
        const assistantMsg: SitesAgentMessage = { id: nextId(), role: "assistant", text: summaryTextRef.current, timestamp: Date.now() }
        setMessages(prev => [...prev, assistantMsg])
        summaryTextRef.current = ""
      }
    }
  }, [])

  // On mount: reconnect to an active stream if one exists
  useEffect(() => {
    const saved = loadStreamState()
    if (saved) {
      connectToStream(saved.streamId, saved.lastSeq)
    }
    // On unmount: close EventSource but DON'T abort the agent — it keeps running server-side
    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [connectToStream])

  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  const cancelStream = useCallback(() => {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
    if (activeStreamId.current) {
      fetch(`${orchestrator}/sites-agent/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: activeStreamId.current }),
      }).catch(() => {})
      activeStreamId.current = null
    }
    summaryTextRef.current = ""
    clearStreamState()
    setIsStreaming(false)
    setStreamStatus(null)
    setStreamSteps([])
    setStreamingText(null)
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreamingRef.current) return

    const userMsg: SitesAgentMessage = { id: nextId(), role: "user", text: text.trim(), timestamp: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setIsStreaming(true)
    setStreamStatus("Starting...")
    setStreamSteps([{ label: "Starting agent", done: false }])
    setStreamingText(null)
    summaryTextRef.current = ""

    let streamId: string
    try {
      const res = await fetch(`${orchestrator}/sites-agent/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, message: text.trim(), locale }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Status ${res.status}` }))
        const errMsg: SitesAgentMessage = { id: nextId(), role: "assistant", text: (err as { error?: string }).error ?? "Failed to start agent", timestamp: Date.now() }
        setMessages(prev => [...prev, errMsg])
        setIsStreaming(false)
        setStreamStatus(null)
        setStreamSteps([])
        return
      }
      const data = await res.json() as { streamId?: string }
      if (!data.streamId) { setIsStreaming(false); return }
      streamId = data.streamId
    } catch {
      setIsStreaming(false)
      setStreamStatus(null)
      setStreamSteps([])
      return
    }

    saveStreamState(streamId, 0)
    connectToStream(streamId, 0)
  }, [session, locale, connectToStream])

  const clearMessages = useCallback(() => {
    cancelStream()
    setMessages([])
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* */ }
  }, [cancelStream])

  return {
    messages,
    isStreaming,
    streamStatus,
    streamSteps,
    streamingText,
    sendMessage,
    cancelStream,
    clearMessages,
  }
}
