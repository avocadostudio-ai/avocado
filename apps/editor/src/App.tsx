import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"

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
  updatedSlug?: string
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
  updatedSlug?: string
  error?: string
}

type HistoryResponse = {
  status?: string
  previewVersion?: number
  error?: string
}

type PublishResponse = {
  status?: string
  session?: string
  slugs?: string[]
  deployStatus?: number
  deployResponse?: string
  inspectUrl?: string
  deploymentId?: string
  vercelState?: string
  error?: string
}

type PublishStatus = {
  session?: string
  status?: string
  startedAt?: string
  updatedAt?: string
  slugs?: string[]
  deployStatus?: number
  inspectUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  vercelState?: string
  lastCheckError?: string
}

const siteOrigin = "http://localhost:3000"
const orchestrator = "http://localhost:4200"

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function slugLabel(route: string) {
  if (route === "/") return "Home (/)"
  const pretty = route
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ")
  return `${pretty || route} (${route})`
}

export function App() {
  const editorOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100"
  const [session] = useState("dev")
  const [slug, setSlug] = useState("/")
  const [availableSlugs, setAvailableSlugs] = useState<string[]>(["/"])
  const [isLoadingSlugs, setIsLoadingSlugs] = useState(false)
  const [modelKey, setModelKey] = useState<ModelKey>("balanced")
  const [message, setMessage] = useState("")
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>()
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>()
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isPublishing, setIsPublishing] = useState(false)
  const [publishStatus, setPublishStatus] = useState<PublishStatus | null>(null)
  const [useStreaming, setUseStreaming] = useState(true)
  const [showNestedLabels, setShowNestedLabels] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [previewRevision, setPreviewRevision] = useState(0)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamTokenCount, setStreamTokenCount] = useState(0)
  const [plannerBadgeState, setPlannerBadgeState] = useState<PlannerBadgeState>("checking")
  const [composerHeight, setComposerHeight] = useState(220)
  const [chatLog, setChatLog] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask for any website change. I will apply it to the preview on the right.",
      status: "ready"
    }
  ])

  const chatPanelRef = useRef<HTMLElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatThreadRef = useRef<HTMLElement>(null)
  const splitHandleRef = useRef<HTMLDivElement>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const resizeStartRef = useRef<{ y: number; composerHeight: number } | null>(null)

  useEffect(() => {
    activeBlockIdRef.current = activeBlockId
  }, [activeBlockId])

  useEffect(() => {
    activeBlockTypeRef.current = activeBlockType
  }, [activeBlockType])

  useEffect(() => {
    activeEditablePathRef.current = activeEditablePath
  }, [activeEditablePath])

  const previewSrc = useMemo(() => {
    const url = new URL(`${siteOrigin}${slug === "/" ? "" : slug}`)
    url.searchParams.set("__editor", "1")
    url.searchParams.set("session", session)
    url.searchParams.set("editorOrigin", editorOrigin)
    url.searchParams.set("__rev", String(previewRevision))
    return url.toString()
  }, [previewRevision, session, slug])

  const routeOptions = useMemo(() => {
    const raw = Array.from(new Set([...availableSlugs, slug].filter(Boolean)))
    return raw.includes("/") ? ["/", ...raw.filter((route) => route !== "/")] : raw
  }, [availableSlugs, slug])

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

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const started = resizeStartRef.current
      if (!started) return
      const panel = chatPanelRef.current
      const thread = chatThreadRef.current
      if (!panel || !thread) return

      const minComposer = 120
      const minThread = 120
      const splitterHeight = 10
      const topRowsHeight = thread.offsetTop
      const maxComposer = Math.max(minComposer, panel.clientHeight - topRowsHeight - splitterHeight - minThread)

      const deltaY = event.clientY - started.y
      const next = Math.min(maxComposer, Math.max(minComposer, started.composerHeight - deltaY))
      setComposerHeight(next)
    }

    const onPointerUp = () => {
      resizeStartRef.current = null
      document.body.style.userSelect = ""
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
    }
  }, [])

  const postToSite = (
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility",
    payload: Record<string, unknown>
  ) => {
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
    postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
  }, [showNestedLabels])

  useEffect(() => {
    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== siteOrigin) return
      const msg = event.data
      if (!msg || msg.protocol !== "site-editor/v1") return

      if (msg.type === "blockClicked") {
        setSlug(String(msg.payload.slug ?? "/"))
        const rawBlockId = msg.payload.blockId
        const rawBlockType = msg.payload.blockType
        const rawPath = msg.payload.editablePath

        const nextBlockId = typeof rawBlockId === "string" && rawBlockId.length > 0 ? rawBlockId : undefined
        const nextBlockType = typeof rawBlockType === "string" && rawBlockType.length > 0 ? rawBlockType : undefined
        const nextPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined

        activeBlockIdRef.current = nextBlockId
        activeBlockTypeRef.current = nextBlockType
        activeEditablePathRef.current = nextPath
        setActiveBlockId(nextBlockId)
        setActiveBlockType(nextBlockType)
        setActiveEditablePath(nextPath)
        if (nextBlockId) postToSite("highlightBlock", { blockId: nextBlockId, editablePath: nextPath ?? null })
      }

      if (msg.type === "routeChanged") {
        setSlug(String(msg.payload.slug ?? "/"))
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
      }

      if (msg.type === "blockReordered") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const afterRaw = msg.payload.afterBlockId
        const afterBlockId = typeof afterRaw === "string" && afterRaw.length > 0 ? afterRaw : undefined
        if (nextSlug !== slug) setSlug(nextSlug)
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
        void reorderBlock(nextSlug, blockId, afterBlockId)
      }

      if (msg.type === "blockDeleteRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        if (nextSlug !== slug) setSlug(nextSlug)
        activeEditablePathRef.current = undefined
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
      const nextSlug = typeof data.updatedSlug === "string" && data.updatedSlug.length > 0 ? data.updatedSlug : slug
      if (nextSlug !== slug) {
        setSlug(nextSlug)
        activeBlockIdRef.current = undefined
        activeBlockTypeRef.current = undefined
        activeEditablePathRef.current = undefined
        setActiveBlockId(undefined)
        setActiveBlockType(undefined)
        setActiveEditablePath(undefined)
      }
      setPreviewRevision((prev) => prev + 1)
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null })
      if (data.focusBlockId) {
        activeBlockIdRef.current = data.focusBlockId
        setActiveBlockId(data.focusBlockId)
      }
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void refreshRouteSlugs()
    }
  }

  async function refreshRouteSlugs() {
    setIsLoadingSlugs(true)
    try {
      const res = await fetch(`${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}`)
      if (!res.ok) return routeOptions
      const data = (await res.json()) as { slugs?: unknown }
      const list = Array.isArray(data.slugs)
        ? data.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []
      if (list.length > 0) {
        setAvailableSlugs(list)
        return list
      }
      return routeOptions
    } catch {
      return routeOptions
    } finally {
      setIsLoadingSlugs(false)
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
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = undefined
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

      activeBlockIdRef.current = undefined
      activeBlockTypeRef.current = undefined
      activeEditablePathRef.current = undefined
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
        activeBlockId: activeBlockIdRef.current,
        activeBlockType: activeBlockTypeRef.current,
        activeEditablePath: activeEditablePathRef.current
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
      if (activeBlockIdRef.current) params.set("activeBlockId", activeBlockIdRef.current)
      if (activeBlockTypeRef.current) params.set("activeBlockType", activeBlockTypeRef.current)
      if (activeEditablePathRef.current) params.set("activeEditablePath", activeEditablePathRef.current)

      const source = new EventSource(`${orchestrator}/chat/stream?${params.toString()}`)
      let settled = false
      let gotAnyEvent = false
      let pendingFocusBlockId: string | null = null
      let opRefreshTimer: number | null = null

      const flushOpRefresh = () => {
        postToSite("draftUpdated", { focusBlockId: pendingFocusBlockId })
        if (pendingFocusBlockId) {
          activeBlockIdRef.current = pendingFocusBlockId
          setActiveBlockId(pendingFocusBlockId)
        }
        activeEditablePathRef.current = undefined
        setActiveEditablePath(undefined)
        pendingFocusBlockId = null
      }

      const clearOpRefreshTimer = () => {
        if (opRefreshTimer === null) return
        window.clearTimeout(opRefreshTimer)
        opRefreshTimer = null
      }

      const scheduleOpRefresh = () => {
        clearOpRefreshTimer()
        opRefreshTimer = window.setTimeout(() => {
          opRefreshTimer = null
          flushOpRefresh()
        }, 100)
      }

      source.onmessage = (event) => {
        let payload: {
          type: "status" | "token" | "op_applied" | "final" | "error"
          message?: string
          text?: string
          index?: number
          total?: number
          focusBlockId?: string | null
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

        if (payload.type === "token") {
          const text = payload.text ?? ""
          if (text) {
            setStreamTokenCount((prev) => prev + text.length)
          }
        }

        if (payload.type === "op_applied") {
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          if (total > 0 && index > 0) {
            setStreamStatus(`Applying changes (${index}/${total})...`)
          } else {
            setStreamStatus("Applying changes...")
          }
          pendingFocusBlockId = typeof payload.focusBlockId === "string" ? payload.focusBlockId : null
          if (total > 0 && index >= total) {
            clearOpRefreshTimer()
            flushOpRefresh()
          } else {
            scheduleOpRefresh()
          }
        }

        if (payload.type === "final") {
          settled = true
          setStreamStatus(null)
          setStreamTokenCount(0)
          clearOpRefreshTimer()
          if (pendingFocusBlockId !== null) flushOpRefresh()
          if (payload.result) applyChatResult(payload.result)
          source.close()
          resolve(true)
        }

        if (payload.type === "error") {
          settled = true
          setStreamStatus(null)
          setStreamTokenCount(0)
          clearOpRefreshTimer()
          pendingFocusBlockId = null
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
          clearOpRefreshTimer()
          pendingFocusBlockId = null
          source.close()
          resolve(true)
          return
        }
        setStreamStatus("Streaming failed, retrying with standard request...")
        setStreamTokenCount(0)
        clearOpRefreshTimer()
        pendingFocusBlockId = null
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
    setMessage("")
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Connecting..." : null)
    setStreamTokenCount(0)
    try {
      if (useStreaming) {
        const ok = await submitChatStream(finalMessage)
        if (!ok) await submitChatHttp(finalMessage)
      } else {
        await submitChatHttp(finalMessage)
      }
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

      activeEditablePathRef.current = undefined
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

  async function publishSite() {
    if (isLoading || isPublishing) return
    setIsPublishing(true)
    try {
      const res = await fetch(`${orchestrator}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session })
      })
      const data = (await res.json()) as PublishResponse
      if (!res.ok || data.status !== "triggered") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Failed to trigger publish.",
          changes: []
        })
        return
      }

      const slugText = Array.isArray(data.slugs) && data.slugs.length > 0 ? data.slugs.join(", ") : "none"
      setPublishStatus({
        session: data.session ?? session,
        status: data.status,
        slugs: data.slugs ?? [],
        deployStatus: data.deployStatus,
        inspectUrl: data.inspectUrl,
        deploymentId: data.deploymentId,
        vercelState: data.vercelState
      })
      void fetchPublishStatus()
      pushAssistantFromResult({
        status: "applied",
        summary: "Publish triggered. Vercel deployment started.",
        changes: [
          `Session: ${data.session ?? session}`,
          `Slugs: ${slugText}`,
          `Deploy status: ${data.deployStatus ?? "unknown"}`,
          `Vercel state: ${data.vercelState ?? "TRIGGERED"}`
        ]
      })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Failed to trigger publish.",
        changes: []
      })
    } finally {
      setIsPublishing(false)
    }
  }

  async function fetchPublishStatus() {
    try {
      const res = await fetch(`${orchestrator}/publish/status?session=${encodeURIComponent(session)}`)
      if (!res.ok) return
      const data = (await res.json()) as PublishStatus
      setPublishStatus(data)
    } catch {
      // Ignore status poll failures.
    }
  }

  useEffect(() => {
    if (!activeBlockId) return
    postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  useEffect(() => {
    void refreshRouteSlugs()
  }, [session])

  useEffect(() => {
    if (!showSettingsModal) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowSettingsModal(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [showSettingsModal])

  const publishState = (publishStatus?.vercelState ?? publishStatus?.status ?? "").toUpperCase()
  const publishInProgress =
    isPublishing || publishState === "PENDING" || publishState === "QUEUED" || publishState === "BUILDING" || publishState === "INITIALIZING"
  const publishTerminal =
    publishState === "READY" || publishState === "ERROR" || publishState === "FAILED" || publishState === "CANCELED" || publishState === "SUCCEEDED"

  useEffect(() => {
    if (!publishStatus || publishTerminal) return
    const timer = window.setInterval(() => {
      void fetchPublishStatus()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [publishStatus, publishTerminal, session])

  const streamIsError = streamStatus ? /failed|error/i.test(streamStatus) : false
  const streamLabel = streamIsError ? streamStatus : streamTokenCount > 0 ? "Shaping your update..." : "Getting things ready..."
  const chatPanelStyle = { "--composer-height": `${composerHeight}px` } as CSSProperties
  const hasUserEntry = chatLog.some((entry) => entry.role === "user")

  return (
    <div className="layout">
      <aside className="chat-panel" ref={chatPanelRef} style={chatPanelStyle}>
        <header className="chat-header">
          <div className="chat-header-controls">
            <label className="chat-header-slug">
              <select value={slug} onChange={(e) => setSlug(e.target.value || "/")} disabled={isLoadingSlugs}>
                {routeOptions.map((route) => (
                  <option key={route} value={route}>
                    {slugLabel(route)}
                  </option>
                ))}
              </select>
            </label>
            <div className="chat-header-primary-actions">
              <button
                type="button"
                className="settings-icon-btn"
                aria-label="Open settings"
                onClick={() => setShowSettingsModal(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M10.33 3.08c.27-1.44 3.07-1.44 3.34 0a1.72 1.72 0 0 0 2.57 1.16c1.27-.74 3.26 1.25 2.52 2.52a1.72 1.72 0 0 0 1.16 2.57c1.44.27 1.44 3.07 0 3.34a1.72 1.72 0 0 0-1.16 2.57c.74 1.27-1.25 3.26-2.52 2.52a1.72 1.72 0 0 0-2.57 1.16c-.27 1.44-3.07 1.44-3.34 0a1.72 1.72 0 0 0-2.57-1.16c-1.27.74-3.26-1.25-2.52-2.52a1.72 1.72 0 0 0-1.16-2.57c-1.44-.27-1.44-3.07 0-3.34a1.72 1.72 0 0 0 1.16-2.57c-.74-1.27 1.25-3.26 2.52-2.52a1.72 1.72 0 0 0 2.57-1.16z" />
                  <circle cx="12" cy="12" r="3.25" />
                </svg>
              </button>
              <button type="button" className="publish-preview-btn" onClick={() => void publishSite()} disabled={isLoading || isPublishing}>
                {publishInProgress ? <span className="publish-spinner" aria-hidden="true" /> : null}
                {publishInProgress ? "Publishing" : "Publish"}
              </button>
            </div>
            {publishStatus?.inspectUrl ? (
              <a className="publish-view-link" href={publishStatus.inspectUrl} target="_blank" rel="noreferrer">
                View deploy
              </a>
            ) : null}
          </div>
        </header>

        <section className="chat-thread" ref={chatThreadRef}>
          {chatLog.map((entry) => (
            <article key={entry.id} className={`msg msg-${entry.role} ${entry.status === "needs_clarification" ? "msg-clarification" : ""}`}>
              <div className="msg-main">{entry.text}</div>
              {entry.status ? <div className="msg-status">{entry.status === "needs_clarification" ? "question" : entry.status}</div> : null}
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
              <span className="streaming-pill-title">
                <span className="streaming-pill-sparkle">✦</span>
              </span>
              <span className="streaming-pill-status">{streamLabel}</span>
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

        <div
          ref={splitHandleRef}
          className="composer-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize input panel"
          onPointerDown={(event) => {
            resizeStartRef.current = { y: event.clientY, composerHeight }
            document.body.style.userSelect = "none"
          }}
        />

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
            placeholder={hasUserEntry ? "" : "Try: Add testimonials below hero"}
            rows={4}
          />
          <div className="composer-actions">
            <div
              className={`source-badge source-badge-bottom ${
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
                ? "OpenAI"
                : plannerBadgeState === "demo"
                  ? "Demo mode"
                  : plannerBadgeState === "error"
                    ? "Status unavailable"
                    : "Checking..."}
            </div>
            <div className="composer-actions-right">
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
          </div>

        </footer>
      </aside>

      <section className="preview">
        <iframe
          ref={iframeRef}
          title="Live preview"
          src={previewSrc}
          onLoad={() => postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })}
        />
      </section>

      {showSettingsModal ? (
        <div className="settings-modal-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button type="button" className="settings-close-btn" aria-label="Close settings" onClick={() => setShowSettingsModal(false)}>
                ×
              </button>
            </div>
            <div className="settings-modal-body">
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

              <label className="inline-toggle">
                <input type="checkbox" checked={showNestedLabels} onChange={(e) => setShowNestedLabels(e.target.checked)} />
                <span>Nested labels</span>
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
