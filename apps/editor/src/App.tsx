import { useEffect, useMemo, useRef, useState } from "react"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"

type AssistantResponse = {
  status?: string
  summary?: string
  changes?: string[]
  previewVersion?: number
  validationErrors?: string[] | { fieldErrors?: Record<string, string[]>; formErrors?: string[] }
  modelUsed?: string
  modelKey?: string
  plannerSource?: "openai" | "demo"
  focusBlockId?: string
  error?: string
}

type SiteMessage = {
  protocol: "site-editor/v1"
  type: "blockClicked" | "routeChanged"
  payload: Record<string, unknown>
}

type ChatEntry = {
  id: string
  role: "user" | "assistant"
  text: string
  status?: string
  changes?: string[]
  errors?: string[]
  meta?: string
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
  const [isLoading, setIsLoading] = useState(false)
  const [useStreaming, setUseStreaming] = useState(true)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [lastPlannerSource, setLastPlannerSource] = useState<"openai" | "demo" | null>(null)
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
        if (nextBlockId) postToSite("highlightBlock", { blockId: nextBlockId })
      }

      if (msg.type === "routeChanged") {
        setSlug(String(msg.payload.slug ?? "/"))
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

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
      errors,
      meta: data.modelUsed ? `${data.modelUsed}${data.modelKey ? ` (${data.modelKey})` : ""}` : undefined
    }

    setChatLog((prev) => [...prev, entry])
  }

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource) setLastPlannerSource(data.plannerSource)
    pushAssistantFromResult(data)
    if (data.status === "applied") {
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null })
      if (data.focusBlockId) setActiveBlockId(data.focusBlockId)
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
        activeBlockType
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

  useEffect(() => {
    if (!activeBlockId) return
    postToSite("highlightBlock", { blockId: activeBlockId })
  }, [activeBlockId])

  return (
    <div className="layout">
      <aside className="chat-panel">
        <header className="chat-header">
          <h1>Site Editor</h1>
          <p>Chat-first editing with live preview</p>
          <div
            className={`source-badge ${lastPlannerSource === "openai" ? "src-openai" : lastPlannerSource === "demo" ? "src-demo" : "src-unknown"}`}
          >
            {lastPlannerSource === "openai" ? "OpenAI" : lastPlannerSource === "demo" ? "Demo fallback" : "Not checked"}
          </div>
        </header>

        <section className="controls">
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
          {streamStatus ? <div className="streaming-pill">{streamStatus}</div> : null}
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

        </footer>
      </aside>

      <section className="preview">
        <iframe ref={iframeRef} title="Live preview" src={previewSrc} />
      </section>
    </div>
  )
}
