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

import { toPastTense } from "../lib/utils"

export type SitesAgentMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  timestamp: number
}

export type PhaseStatus = {
  id: string
  activeLabel: string
  doneLabel: string
  status: "active" | "done"
  outcome?: string
}

export type ApprovalQuestion = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect: boolean
}

export type PendingApproval = {
  streamId: string
  questions: ApprovalQuestion[]
}

export type UseSitesAgentReturn = {
  messages: SitesAgentMessage[]
  isStreaming: boolean
  streamStatus: string | null
  streamSteps: { label: string; done: boolean; count?: number }[]
  streamPhases: PhaseStatus[]
  streamingText: string | null
  followUpSuggestions: string[]
  pendingApproval: PendingApproval | null
  sendMessage: (text: string) => void
  respondToApproval: (answers: Record<string, string>) => void
  cancelStream: () => void
  clearMessages: () => void
}

/** Detect whether the user wants to integrate an existing codebase vs migrate a URL. */
function detectAgentMode(text: string): "migrate" | "integrate" {
  const lower = text.toLowerCase()
  if (/\bintegrat(e|ion|ing)\b/.test(lower)) return "integrate"
  if (/\badd\s+(the\s+)?sdk\b/.test(lower)) return "integrate"
  if (/\bexisting\s+(site|project|codebase|repo)\b/.test(lower)) return "integrate"
  if (/\bconnect\s+(to\s+)?(the\s+)?editor\b/.test(lower)) return "integrate"
  return "migrate"
}

const STEP_LABEL_MAP: Record<string, string> = {
  "Agent": "Processing",
  "generate_page_specs": "Generating page specs",
  "download_remote_image": "Downloading image",
  "download_remote_images": "Downloading images",
  "create_site": "Creating site",
  "bootstrap_pages": "Building pages",
  "apply_theme": "Applying theme",
  "clone_repo": "Cloning repository",
  "analyze_codebase": "Analyzing codebase",
  "integrate_site": "Integrating site",
  "launch_site": "Launching site",
  "register_site": "Registering site",
}

function humanizeStepLabel(label: string): string {
  if (STEP_LABEL_MAP[label]) return STEP_LABEL_MAP[label]
  // Convert snake_case/camelCase to readable text
  return label
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, c => c.toUpperCase())
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
  const [streamPhases, setStreamPhases] = useState<PhaseStatus[]>([])
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [followUpSuggestions, setFollowUpSuggestions] = useState<string[]>([])
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)

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
        const label = humanizeStepLabel(msg.replace(/\.\.\.$/, ""))
        setStreamSteps(prev => {
          // If the same step is still active, skip the update
          const activeIdx = prev.findIndex(s => !s.done)
          if (activeIdx >= 0 && prev[activeIdx].label === label) return prev
          const done = prev.map(s => s.done ? s : { ...s, label: toPastTense(s.label), done: true })
          if (done.length > 0 && done[done.length - 1].label === toPastTense(label)) {
            const last = done[done.length - 1]
            done[done.length - 1] = { ...last, count: (last.count ?? 1) + 1 }
            return [...done, { label, done: false }]
          }
          return [...done, { label, done: false }]
        })
      } else if (type === "heartbeat") {
        const elapsedMs = Number(d.elapsedMs ?? 0)
        const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000))
        // Only update every 5s to reduce re-renders
        if (elapsedSec % 5 === 0) {
          setStreamStatus(`Agent working... ${elapsedSec}s`)
        }
      } else if (type === "summary_token") {
        // Accumulate for the final assistant message, but don't stream to UI —
        // the StepTracker provides real-time progress; text is shown only at completion.
        summaryTextRef.current += d.text as string
      } else if (type === "phase") {
        const phaseId = d.phase as string
        const activeLabel = d.activeLabel as string
        const doneLabel = d.doneLabel as string
        setStreamPhases(prev => {
          const updated = prev.map(p => p.status === "active" ? { ...p, status: "done" as const } : p)
          return [...updated, { id: phaseId, activeLabel, doneLabel, status: "active" as const }]
        })
      } else if (type === "phase_outcome") {
        const phaseId = d.phase as string
        const outcome = d.outcome as string
        setStreamPhases(prev =>
          prev.map(p => p.id === phaseId ? { ...p, outcome } : p)
        )
      } else if (type === "phase_done") {
        const phaseId = d.phase as string
        setStreamPhases(prev =>
          prev.map(p => p.id === phaseId && p.status === "active" ? { ...p, status: "done" as const } : p)
        )
      } else if (type === "approval_required") {
        const input = d.input as Record<string, unknown>
        const questions = (input?.questions ?? []) as ApprovalQuestion[]
        setPendingApproval({ streamId, questions })
        setStreamStatus("Waiting for your approval...")
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

        const suggestions = Array.isArray(result.suggestions) ? (result.suggestions as string[]).filter(s => typeof s === "string" && s.trim()) : []
        setFollowUpSuggestions(suggestions)

        source.close()
        eventSourceRef.current = null
        activeStreamId.current = null
        summaryTextRef.current = ""
        clearStreamState()
        setIsStreaming(false)
        setStreamStatus(null)
        setStreamSteps([])
        setStreamPhases([])
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
        setStreamPhases([])
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
    setStreamSteps([])
    setStreamPhases([])
    setStreamingText(null)
    setFollowUpSuggestions([])
    summaryTextRef.current = ""

    let streamId: string
    try {
      const res = await fetch(`${orchestrator}/sites-agent/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, message: text.trim(), locale, useCliAgent: import.meta.env.VITE_AGENT_USE_CLI === "true", mode: detectAgentMode(text) }),
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

  const respondToApproval = useCallback(async (answers: Record<string, string>) => {
    if (!pendingApproval) return
    setPendingApproval(null)
    setStreamStatus("Executing migration plan...")
    try {
      await fetch(`${orchestrator}/sites-agent/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: pendingApproval.streamId, answers }),
      })
    } catch (err) {
      console.error("[sites-agent] Failed to respond to approval:", err)
    }
  }, [pendingApproval])

  const clearMessages = useCallback(() => {
    cancelStream()
    setMessages([])
    setPendingApproval(null)
    try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* */ }
  }, [cancelStream])

  return {
    messages,
    isStreaming,
    streamStatus,
    streamSteps,
    streamPhases,
    streamingText,
    followUpSuggestions,
    pendingApproval,
    sendMessage,
    respondToApproval,
    cancelStream,
    clearMessages,
  }
}
