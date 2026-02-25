import { useEffect, useMemo, useRef, useState } from "react"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
type PlannerSource = "openai" | "demo"
type PlannerBadgeState = PlannerSource | "checking" | "error"

type AssistantResponse = {
  status?: string
  summary?: string
  changes?: string[]
  previewVersion?: number
  validationErrors?: string[] | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
  modelUsed?: string
  modelKey?: string
  plannerSource?: PlannerSource
  focusBlockId?: string
  suggestions?: string[]
  error?: string
}

type SiteMessage = {
  protocol: "site-editor/v1"
  type: "blockClicked" | "routeChanged" | "blockReordered" | "blockDeleteRequested"
  payload: Record<string, unknown>
}

type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  status?: string
  changes?: string[]
  suggestions?: string[]
  errors?: string[]
  meta?: string
}

type ApplyOpsResponse = {
  status?: string
  summary?: string
  changes?: string[]
  previewVersion?: number
  focusBlockId?: string
  error?: string
}

type HistoryResponse = {
  status?: string
  previewVersion?: number
  error?: string
}

const editorOrigin = "http://localhost:4100"
const siteOrigin = "http://localhost:3000"
const orchestrator = "http://localhost:4200"

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function App() {
  const [session] = useState("dev")
  const [slug, setSlug] = useState("/")
  const [modelKey, setModelKey] = useState<ModelKey>("balanced")
  const [message, setMessage] = useState("")
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>()
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>()
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [useStreaming, setUseStreaming] = useState(true)
  const [showControls, setShowControls] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [plannerBadgeState, setPlannerBadgeState] = useState<PlannerBadgeState>("checking")
  const [chatLog, setChatLog] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask for any website change. I will apply it to the preview on the right.",
      status: "ready"
    }
  ])

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatThreadRef = useRef<HTMLElement>(null)

  const previewSrc = useMemo(() => {
    const url = new URL(`${siteOrigin}${slug === "/" ? "" : slug}`)
    url.searchParams.set("__editor", "1")
    url.searchParams.set("session", session)
    url.searchParams.set("editorOrigin", editorOrigin)
    return url.toString()
  }, [session, slug])

  useEffect(() => {
    let active = true

    const checkPlannerStatus = async () => {
      const urls = [`${orchestrator}/status/planner`]
      if (orchestrator.includes("localhost")) {
        urls.push(`${orchestrator.replace("localhost", "127.0.0.1")}/status/planner`)
      }

      try {
        for (const url of urls) {
          const res = await fetch(url)
          if (!res.ok) continue

          const data = (await res.json()) as { plannerSource?: PlannerSource }
          if (!active) return

          if (data.plannerSource === "openai" || data.plannerSource === "demo") {
            setPlannerBadgeState(data.plannerSource)
            return
          }
        }
        if (active) setPlannerBadgeState("error")
      } catch {
        if (active) setPlannerBadgeState("error")
      }
    }

    void checkPlannerStatus()
    const timer = window.setInterval(() => {
      void checkPlannerStatus()
    }, 10000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const thread = chatThreadRef.current
    if (!thread) return
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" })
  }, [chatLog, streamStatus])

  const postToSite = (type: "highlightBlock" | "draftUpdated", payload: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        protocol: "site-editor/v1",
        type,
        payload
      },
      siteOrigin
    )
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== siteOrigin) return
      const msg = event.data
      if (!msg || msg.protocol !== "site-editor/v1") return

      if (msg.type === "blockClicked") {
        setSlug(String(msg.payload.slug ?? "/"))
        const nextBlockId = String(msg.payload.blockId ?? "")
        setActiveBlockId(nextBlockId || undefined)
        setActiveBlockType(String(msg.payload.blockType ?? "") || undefined)
        const path = String(msg.payload.editablePath ?? "")
        setActiveEditablePath(path || undefined)
        if (nextBlockId) postToSite("highlightBlock", { blockId: nextBlockId, editablePath: path || null })
      }

      if (msg.type === "routeChanged") {
        setSlug(String(msg.payload.slug ?? "/"))
        setActiveEditablePath(undefined)
      }

      if (msg.type === "blockReordered") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = String(msg.payload.blockId ?? "")
        const afterRaw = msg.payload.afterBlockId
        const afterBlockId = typeof afterRaw === "string" && afterRaw.length > 0 ? afterRaw : undefined
        if (nextSlug !== slug) setSlug(nextSlug)
        setActiveEditablePath(undefined)
        void reorderBlock(nextSlug, blockId, afterBlockId)
      }

      if (msg.type === "blockDeleteRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = String(msg.payload.blockId ?? "")
        if (nextSlug !== slug) setSlug(nextSlug)
        setActiveEditablePath(undefined)
        void deleteBlock(nextSlug, blockId)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [slug])

  function normalizeValidationErrors(raw: AssistantResponse["validationErrors"]) {
    if (!raw) return []
    if (Array.isArray(raw)) return raw.map(String)
    const field = Object.values(raw.fieldErrors ?? {}).flat().map(String)
    const form = (raw.formErrors ?? []).map(String)
    return [...form, ...field]
  }

  function pushAssistantFromResult(data: AssistantResponse) {
    const errors = normalizeValidationErrors(data.validationErrors)
    const entry: ChatEntry = {
      id: createId(),
      role: "assistant",
      text: data.summary ?? data.error ?? "Request failed.",
      status: data.status,
      changes: data.changes ?? [],
      suggestions: data.suggestions ?? [],
      errors,
      meta: data.modelUsed ? `${data.modelUsed}${data.modelKey ? ` (${data.modelKey})` : ""}` : undefined
    }

    setChatLog((prev) => [...prev, entry])
  }

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource === "openai" || data.plannerSource === "demo") {
      setPlannerBadgeState(data.plannerSource)
    }
    pushAssistantFromResult(data)
    if (data.status === "applied") {
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null })
      if (data.focusBlockId) setActiveBlockId(data.focusBlockId)
      setActiveEditablePath(undefined)
    }
  }

  async function reorderBlock(slugForOp: string, blockId: string, afterBlockId?: string) {
    if (!blockId) return
    const op: Record<string, unknown> = { op: "move_block", pageSlug: slugForOp, blockId }
    if (afterBlockId) op.afterBlockId = afterBlockId

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not reorder blocks.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      setActiveBlockId(focusBlockId)
      postToSite("draftUpdated", { focusBlockId })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not reorder blocks.",
        changes: []
      })
    }
  }

  async function deleteBlock(slugForOp: string, blockId: string) {
    if (!blockId) return
    const op = { op: "remove_block", pageSlug: slugForOp, blockId }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not delete block.",
          changes: data.changes ?? []
        })
        return
      }

      setActiveBlockId(undefined)
      setActiveBlockType(undefined)
      setActiveEditablePath(undefined)
      postToSite("draftUpdated", { focusBlockId: null })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not delete block.",
        changes: []
      })
    }
  }

  async function submitChatHttp(finalMessage: string) {
    const res = await fetch(`${orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        slug,
        message: finalMessage,
        modelKey,
        activeBlockId,
        activeBlockType,
        activeEditablePath
      })
    })

    const data = (await res.json()) as AssistantResponse
    applyChatResult(data)
  }

  async function submitChatStream(finalMessage: string) {
    return await new Promise<boolean>((resolve) => {
      const params = new URLSearchParams({
        session,
        slug,
        message: finalMessage,
        modelKey
      })
      if (activeBlockId) params.set("activeBlockId", activeBlockId)
      if (activeBlockType) params.set("activeBlockType", activeBlockType)
      if (activeEditablePath) params.set("activeEditablePath", activeEditablePath)

      const source = new EventSource(`${orchestrator}/chat/stream?${params.toString()}`)
      let settled = false
      let gotAnyEvent = false

      source.onmessage = (event) => {
        let payload: {
          type: "status" | "final" | "error"
          message?: string
          result?: AssistantResponse
        }
        try {
          payload = JSON.parse(event.data) as typeof payload
        } catch {
          return
        }
        gotAnyEvent = true

        if (payload.type === "status") {
          setStreamStatus(payload.message ?? "Working...")
        }

        if (payload.type === "final") {
          settled = true
          setStreamStatus(null)
          if (payload.result) applyChatResult(payload.result)
          source.close()
          resolve(true)
        }

        if (payload.type === "error") {
          settled = true
          setStreamStatus(null)
          if (payload.result) {
            applyChatResult(payload.result)
          } else {
            pushAssistantFromResult({ status: "error", summary: "Streaming request failed.", changes: [] })
          }
          source.close()
          resolve(true)
        }
      }

      source.onerror = () => {
        if (settled || gotAnyEvent) {
          source.close()
          resolve(true)
          return
        }
        setStreamStatus("Streaming failed, retrying with standard request...")
        settled = true
        source.close()
        resolve(false)
      }
    })
  }

  async function submitChat(explicitMessage?: string) {
    const finalMessage = (explicitMessage ?? message).trim()
    if (!finalMessage || isLoading) return

    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: finalMessage }])
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Connecting..." : null)
    try {
      if (useStreaming) {
        const ok = await submitChatStream(finalMessage)
        if (!ok) await submitChatHttp(finalMessage)
      } else {
        await submitChatHttp(finalMessage)
      }
      setMessage("")
    } finally {
      setStreamStatus(null)
      setIsLoading(false)
    }
  }

  async function applyHistory(action: "undo" | "redo") {
    if (isLoading) return
    try {
      const res = await fetch(`${orchestrator}/history/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, slug })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? `Could not ${action}.`,
          changes: []
        })
        return
      }

      setActiveEditablePath(undefined)
      postToSite("draftUpdated", { focusBlockId: null })
      pushAssistantFromResult({
        status: "applied",
        summary: action === "undo" ? "Undid last change." : "Redid last change.",
        changes: []
      })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: `Could not ${action}.`,
        changes: []
      })
    }
  }

  useEffect(() => {
    if (!activeBlockId) return
    postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  const streamIsError = streamStatus ? /failed|error/i.test(streamStatus) : false
  const streamLabel = streamIsError ? streamStatus : "Crafting your updates"

  return (
    <div className="layout">
      <aside className="chat-panel">
        <header className="chat-header">
          <h1>Site Editor</h1>
          <p>Chat-first editing with live preview</p>
          <div
            className={`source-badge ${
              plannerBadgeState === "openai"
                ? "src-openai"
                : plannerBadgeState === "demo"
                  ? "src-demo"
                  : plannerBadgeState === "error"
                    ? "src-error"
                    : "src-unknown"
            }`}
          >
            {plannerBadgeState === "openai"
              ? "OpenAI connected"
              : plannerBadgeState === "demo"
                ? "Demo mode"
                : plannerBadgeState === "error"
                  ? "Status unavailable"
                  : "Checking..."}
          </div>
        </header>

        <section className={`controls ${showControls ? "open" : ""}`}>
          <button
            type="button"
            className="controls-toggle"
            aria-expanded={showControls}
            onClick={() => setShowControls((prev) => !prev)}
          >
            <span>Settings</span>
            <span aria-hidden="true">{showControls ? "▾" : "▸"}</span>
          </button>

          <div className="controls-body">
            <label>
              <span>Route</span>
              <input value={slug} onChange={(e) => setSlug(e.target.value || "/")} />
            </label>

            <label>
              <span>Model</span>
              <select value={modelKey} onChange={(e) => setModelKey(e.target.value as ModelKey)}>
                <option value="fast">fast</option>
                <option value="balanced">balanced</option>
                <option value="reasoning">reasoning</option>
                <option value="codex">codex</option>
              </select>
            </label>

            <label className="inline-toggle">
              <input type="checkbox" checked={useStreaming} onChange={(e) => setUseStreaming(e.target.checked)} />
              <span>Streaming</span>
            </label>
          </div>
        </section>

        <section className="chat-thread" ref={chatThreadRef}>
          {chatLog.map((entry) => (
            <article key={entry.id} className={`msg msg-${entry.role}`}>
              <div className="msg-main">{entry.text}</div>
              {entry.status ? <div className="msg-status">{entry.status}</div> : null}
              {(entry.changes ?? []).length > 0 ? (
                <ul className="msg-list">
                  {entry.changes?.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {(entry.suggestions ?? []).length > 0 ? (
                <div className="msg-suggestions">
                  {entry.suggestions?.map((line, idx) => (
                    <button
                      key={`${entry.id}-${idx}`}
                      type="button"
                      className="msg-suggestion"
                      onClick={() => void submitChat(line)}
                      disabled={isLoading}
                    >
                      {line}
                    </button>
                  ))}
                </div>
              ) : null}
              {(entry.errors ?? []).length > 0 ? (
                <ul className="msg-errors">
                  {entry.errors?.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {entry.meta ? <div className="msg-meta">{entry.meta}</div> : null}
            </article>
          ))}
          {streamStatus ? (
            <div className={`streaming-pill ${streamIsError ? "is-error" : "is-active"}`}>
              <span>{streamLabel}</span>
              {!streamIsError ? (
                <span className="streaming-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </div>
          ) : null}
          <div ref={chatEndRef} />
        </section>

        <footer className="composer">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void submitChat()
              }
            }}
            placeholder="Try: Add testimonials below hero"
            rows={4}
          />
          <div className="composer-actions">
            <button type="button" className="secondary-btn" onClick={() => void applyHistory("undo")} disabled={isLoading}>
              Undo
            </button>
            <button type="button" className="secondary-btn" onClick={() => void applyHistory("redo")} disabled={isLoading}>
              Redo
            </button>
            <button type="button" className="primary-btn" onClick={() => void submitChat()} disabled={isLoading || message.trim().length === 0}>
              Send
            </button>
          </div>

        </footer>
      </aside>

      <section className="preview">
        <iframe ref={iframeRef} title="Live preview" src={previewSrc} />
      </section>
    </div>
  )
}
