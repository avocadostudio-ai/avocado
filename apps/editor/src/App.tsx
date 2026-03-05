import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Check, Copy } from "lucide-react"
import ClaudeStyleChatInput from "./components/claude-style-chat-input"
import Settings2Icon from "./components/settings2-icon"
import { VariationScaledPreview } from "./components/VariationScaledPreview"
import { SitesPage } from "./components/SitesPage"
import { useSiteList } from "./hooks/useSiteList"
import { usePreviewBridge, type PreviewBridgeCallbacks } from "./hooks/usePreviewBridge"
import { useChatEngine } from "./hooks/useChatEngine"
import { usePublish } from "./hooks/usePublish"
import { useMediaInput } from "./hooks/useMediaInput"
import { resolveStreamingIndicatorStyle } from "./config/streaming-indicator"
import { allowedBlockTypes, getAllBlockMeta, type BlockInstance } from "@ai-site-editor/shared"
import type { AIProvider, ModelKey, PlannerSource } from "./lib/editor-types"
import {
  DEBUG_MODE_STORAGE_KEY,
  MODEL_KEY_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  CHAT_THEME_STORAGE_KEY,
  isRedundantChangeLine,
  mergedVariationProps,
  orchestrator,
  previewPresetWidths,
  buildSiteDraftDisableUrl,
  buildSiteDraftEnableUrl,
  resolveDefaultChatDarkMode,
  resolveDefaultDebugMode,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  resolveEditorSiteId,
  siteOrigin,
  slugLabel
} from "./lib/editor-utils"

const STREAMING_INDICATOR_STYLE = resolveStreamingIndicatorStyle()

export function App() {
  const pathName = typeof window !== "undefined" ? window.location.pathname : "/"
  const isSitesPage = pathName === "/sites" || pathName === "/sites/"
  const [chatDarkMode, setChatDarkMode] = useState(() => resolveDefaultChatDarkMode())
  const [session] = useState("dev")
  const [siteId] = useState(() => resolveEditorSiteId())
  const sites = useSiteList(siteId, session)

  useEffect(() => {
    if (typeof window === "undefined") return
    const root = window.document.documentElement
    root.classList.toggle("editor-dark", chatDarkMode)
    window.sessionStorage.setItem(CHAT_THEME_STORAGE_KEY, chatDarkMode ? "dark" : "light")
    window.localStorage.setItem(CHAT_THEME_STORAGE_KEY, chatDarkMode ? "dark" : "light")
  }, [chatDarkMode])

  if (isSitesPage) return <SitesPage sites={sites} session={session} />

  return <EditorPage siteId={siteId} session={session} sites={sites} chatDarkMode={chatDarkMode} onSetChatDarkMode={setChatDarkMode} />
}

function EditorPage({
  siteId,
  session,
  sites,
  chatDarkMode,
  onSetChatDarkMode
}: {
  siteId: string
  session: string
  sites: ReturnType<typeof useSiteList>
  chatDarkMode: boolean
  onSetChatDarkMode: (value: boolean) => void
}) {
  const editorOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100"
  const { activeSiteConfig } = sites

  const [slug, setSlug] = useState("/")
  const [availableSlugs, setAvailableSlugs] = useState<string[]>(["/"])
  const [isLoadingSlugs, setIsLoadingSlugs] = useState(false)
  const [modelKey, setModelKey] = useState<ModelKey>(() => resolveDefaultModelKey())
  const [provider, setProvider] = useState<AIProvider>(() => resolveDefaultProvider())
  const [availableProviders, setAvailableProviders] = useState<AIProvider[]>([])
  const [message, setMessage] = useState("")
  const [activeBlockId, setActiveBlockId] = useState<string | undefined>()
  const [activeBlockType, setActiveBlockType] = useState<string | undefined>()
  const [activeEditablePath, setActiveEditablePath] = useState<string | undefined>()
  const [useStreaming, setUseStreaming] = useState(true)
  const [showNestedLabels, setShowNestedLabels] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showDebugDetails, setShowDebugDetails] = useState(() => resolveDefaultDebugMode())
  const [composerHeight, setComposerHeight] = useState(124)
  const [settingsPopoverPos, setSettingsPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const [addBlockPicker, setAddBlockPicker] = useState<{ slug: string; afterBlockId?: string; beforeBlockId?: string } | null>(null)
  const [addBlockSearch, setAddBlockSearch] = useState("")
  const [isAddingBlock, setIsAddingBlock] = useState(false)
  const [copiedDebugEntryId, setCopiedDebugEntryId] = useState<string | null>(null)

  const chatPanelRef = useRef<HTMLElement>(null)
  const chatThreadRef = useRef<HTMLElement>(null)
  const splitHandleRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const resizeStartRef = useRef<{ y: number; composerHeight: number } | null>(null)

  const routeOptions = useMemo(() => {
    const raw = Array.from(new Set([...availableSlugs, slug].filter(Boolean)))
    return raw.includes("/") ? ["/", ...raw.filter((route) => route !== "/")] : raw
  }, [availableSlugs, slug])

  const blockTypeOptions = useMemo(() => {
    const meta = getAllBlockMeta()
    return [...allowedBlockTypes]
      .map((type) => ({
        type,
        label: meta[type]?.displayName ?? type,
        category: meta[type]?.category ?? "content"
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [])

  const groupedBlockTypeOptions = useMemo(() => {
    const query = addBlockSearch.trim().toLowerCase()
    const filtered = query
      ? blockTypeOptions.filter((option) => option.label.toLowerCase().includes(query) || option.type.toLowerCase().includes(query))
      : blockTypeOptions

    const groups = new Map<string, typeof filtered>()
    for (const option of filtered) {
      const key = option.category || "content"
      const existing = groups.get(key)
      if (existing) {
        existing.push(option)
      } else {
        groups.set(key, [option])
      }
    }

    const ordered = ["content", "layout", "conversion", "navigation", "media"]
    return [...groups.entries()]
      .sort((a, b) => {
        const ai = ordered.indexOf(a[0])
        const bi = ordered.indexOf(b[0])
        const safeAi = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
        const safeBi = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
        if (safeAi !== safeBi) return safeAi - safeBi
        return a[0].localeCompare(b[0])
      })
      .map(([category, options]) => ({ category, options }))
  }, [addBlockSearch, blockTypeOptions])

  const previewCallbacks = useMemo<PreviewBridgeCallbacks>(() => ({
    onBlockClicked: (newSlug, blockId, blockType, editablePath) => {
      setSlug(newSlug)
      activeBlockIdRef.current = blockId
      activeBlockTypeRef.current = blockType
      activeEditablePathRef.current = editablePath
      setActiveBlockId(blockId)
      setActiveBlockType(blockType)
      setActiveEditablePath(editablePath)
      if (blockId) preview.postToSite("highlightBlock", { blockId, editablePath: editablePath ?? null })
    },
    onRouteChanged: (newSlug) => {
      setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
    },
    onBlockReordered: (newSlug, blockId, afterBlockId) => {
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.reorderBlock(newSlug, blockId, afterBlockId)
    },
    onBlockDeleteRequested: (newSlug, blockId) => {
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.deleteBlock(newSlug, blockId)
    },
    onBlockAddRequested: (newSlug, args) => {
      if (newSlug !== slug) setSlug(newSlug)
      if (!args.afterBlockId && !args.beforeBlockId) return
      setAddBlockPicker({ slug: newSlug, afterBlockId: args.afterBlockId, beforeBlockId: args.beforeBlockId })
    },
    onListItemAddRequested: (newSlug, blockId, blockType, listKey, afterIndex) => {
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.addListItem(newSlug, blockId, blockType, listKey, afterIndex)
    },
    onListItemRemoveRequested: (newSlug, blockId, blockType, listKey, index) => {
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.removeListItem(newSlug, blockId, blockType, listKey, index)
    },
    onListItemMoveRequested: (newSlug, blockId, blockType, listKey, index, afterIndex) => {
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.moveListItem(newSlug, blockId, blockType, listKey, index, afterIndex)
    },
    onInlineTextCommitted: (newSlug, blockId, editablePath, value) => {
      if (newSlug !== slug) setSlug(newSlug)
      if (editablePath) {
        activeEditablePathRef.current = editablePath
        setActiveEditablePath(editablePath)
      }
      void chatEngine.inlineEditCommit(newSlug, blockId, editablePath, value)
    }
  }), [slug])

  const preview = usePreviewBridge(slug, previewCallbacks)

  const chatEngine = useChatEngine({
    session,
    siteId,
    activeSiteConfig,
    slug,
    setSlug,
    modelKey,
    provider,
    useStreaming,
    activeBlockIdRef,
    activeBlockTypeRef,
    activeEditablePathRef,
    setActiveBlockId,
    setActiveBlockType,
    setActiveEditablePath,
    postToSite: preview.postToSite,
    postPatchToSite: preview.postPatchToSite,
    setAvailableSlugs,
    setIsLoadingSlugs,
    routeOptions
  })

  const publish = usePublish(session, siteId, chatEngine.isLoading, chatEngine.pushAssistantFromResult)

  const media = useMediaInput()

  // Sync refs
  useEffect(() => { activeBlockIdRef.current = activeBlockId }, [activeBlockId])
  useEffect(() => { activeBlockTypeRef.current = activeBlockType }, [activeBlockType])
  useEffect(() => { activeEditablePathRef.current = activeEditablePath }, [activeEditablePath])

  // Persist debug mode
  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, showDebugDetails ? "1" : "0")
  }, [showDebugDetails])

  // Persist model & provider selection
  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(MODEL_KEY_STORAGE_KEY, modelKey)
  }, [modelKey])
  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider)
  }, [provider])

  // Preview src
  const previewSrc = useMemo(() => {
    return buildSiteDraftEnableUrl(slug, {
      session,
      siteId,
      editorOrigin
    })
  }, [editorOrigin, session, siteId, slug])

  const liveSiteUrl = useMemo(() => {
    const configured = activeSiteConfig.vercelProductionUrl?.trim()
    const base = configured && /^https?:\/\//i.test(configured) ? configured : siteOrigin
    try {
      const url = new URL(base)
      if (url.origin === siteOrigin) {
        return buildSiteDraftDisableUrl(slug, {})
      }
      url.pathname = slug === "/" ? "/" : slug
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return undefined
    }
  }, [activeSiteConfig.vercelProductionUrl, slug])

  // Planner status check
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
          const data = (await res.json()) as { plannerSource?: PlannerSource; availableProviders?: AIProvider[] }
          if (!active) return
          if (Array.isArray(data.availableProviders) && data.availableProviders.length > 0) {
            setAvailableProviders(data.availableProviders)
            if (!data.availableProviders.includes(provider)) setProvider(data.availableProviders[0])
          }
          if (data.plannerSource === "openai" || data.plannerSource === "anthropic" || data.plannerSource === "demo") {
            chatEngine.setPlannerBadgeState(data.plannerSource)
            return
          }
        }
        if (active) chatEngine.setPlannerBadgeState("error")
      } catch {
        if (active) chatEngine.setPlannerBadgeState("error")
      }
    }
    void checkPlannerStatus()
    const timer = window.setInterval(() => { void checkPlannerStatus() }, 10000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  // Scroll chat on new entries
  useEffect(() => {
    const thread = chatThreadRef.current
    if (!thread) return
    thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" })
  }, [chatEngine.chatLog, chatEngine.streamStatus])

  // Nested labels sync
  useEffect(() => {
    preview.postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
  }, [showNestedLabels])

  // Highlight active block sync
  useEffect(() => {
    if (!activeBlockId) return
    preview.postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  // Refresh slugs on session/site change
  useEffect(() => { void chatEngine.refreshRouteSlugs() }, [session, siteId])

  // Composer resize
  const clampComposerHeight = (value: number) => {
    const minComposer = 124
    const panel = chatPanelRef.current
    const thread = chatThreadRef.current
    if (!panel || !thread) return Math.max(minComposer, value)
    const minThread = 120
    const splitterHeight = 10
    const topRowsHeight = thread.offsetTop
    const maxComposer = Math.max(minComposer, panel.clientHeight - topRowsHeight - splitterHeight - minThread)
    return Math.min(maxComposer, Math.max(minComposer, value))
  }

  const handleComposerAutoHeight = useCallback((height: number) => {
    setComposerHeight((prev) => {
      const next = clampComposerHeight(height)
      return next === prev ? prev : next
    })
  }, [])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const started = resizeStartRef.current
      if (!started) return
      const deltaY = event.clientY - started.y
      const next = clampComposerHeight(started.composerHeight - deltaY)
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

  useEffect(() => {
    const onWindowResize = () => { setComposerHeight((prev) => clampComposerHeight(prev)) }
    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [])

  // Settings popover positioning
  useEffect(() => {
    if (!showSettingsModal) return
    const updatePopoverPosition = () => {
      const button = settingsButtonRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const popoverWidth = 320
      const popoverHeight = 220
      const gap = 8
      const minEdge = 8
      const maxLeft = Math.max(minEdge, window.innerWidth - popoverWidth - minEdge)
      const maxTop = Math.max(minEdge, window.innerHeight - popoverHeight - minEdge)
      const left = Math.min(maxLeft, Math.max(minEdge, rect.right - popoverWidth))
      const top = Math.min(maxTop, Math.max(minEdge, rect.bottom + gap))
      setSettingsPopoverPos({ top, left })
    }
    updatePopoverPosition()
    window.addEventListener("resize", updatePopoverPosition)
    window.addEventListener("scroll", updatePopoverPosition, true)
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setShowSettingsModal(false) }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", updatePopoverPosition)
      window.removeEventListener("scroll", updatePopoverPosition, true)
    }
  }, [showSettingsModal])

  // Variation modal escape
  useEffect(() => {
    if (!chatEngine.variationModal) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !chatEngine.isApplyingVariation) chatEngine.setVariationModal(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [chatEngine.variationModal, chatEngine.isApplyingVariation])

  useEffect(() => {
    if (!addBlockPicker) setAddBlockSearch("")
  }, [addBlockPicker])

  useEffect(() => {
    if (!addBlockPicker) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isAddingBlock) setAddBlockPicker(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [addBlockPicker, isAddingBlock])

  const streamIsError = chatEngine.streamStatus ? /failed|error/i.test(chatEngine.streamStatus) : false
  const streamLabel = chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? "Shaping your update..." : "Getting things ready...")
  const streamTextLabel = chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? "Updating..." : "Thinking")
  const chatPanelStyle = { "--composer-height": `${composerHeight}px` } as CSSProperties
  const hasUserEntry = chatEngine.chatLog.some((entry) => entry.role === "user")
  const buildCopyPayload = useCallback((entry: (typeof chatEngine.chatLog)[number]) => {
    const lines: string[] = []
    if (entry.text) lines.push(entry.text)
    if (entry.aiJustification) lines.push(`AI justification: ${entry.aiJustification}`)
    if (entry.aiPerformanceNote) lines.push(`Performance awareness: ${entry.aiPerformanceNote}`)
    if (entry.status && !entry.canUndo && entry.status !== "needs_clarification" && entry.status !== "plan_ready") lines.push(`status: ${entry.status}`)
    const changeLines = (entry.changes ?? []).filter((line) => !isRedundantChangeLine(entry.text, line))
    if (changeLines.length > 0) lines.push(`changes: ${changeLines.join("\n")}`)
    if ((entry.errors ?? []).length > 0) lines.push(`errors: ${(entry.errors ?? []).join("\n")}`)
    if (entry.debug) {
      lines.push("")
      lines.push("Debug")
      if (entry.debug.traceId) lines.push(`traceId: ${entry.debug.traceId}`)
      if (entry.debug.promptHash) lines.push(`promptHash: ${entry.debug.promptHash}`)
      if (entry.debug.outcome) lines.push(`outcome: ${entry.debug.outcome}`)
      if (entry.debug.reasonCategory) lines.push(`reason: ${entry.debug.reasonCategory}`)
      if (entry.debug.intent) lines.push(`intent: ${entry.debug.intent}`)
      if (typeof entry.debug.opCount === "number") lines.push(`opCount: ${entry.debug.opCount}`)
      if (typeof entry.debug.skippedOpCount === "number" && entry.debug.skippedOpCount > 0) lines.push(`skippedOps: ${entry.debug.skippedOpCount}`)
      if (Array.isArray(entry.debug.opTypes) && entry.debug.opTypes.length > 0) lines.push(`ops: ${entry.debug.opTypes.join(", ")}`)
      if (Array.isArray(entry.debug.timeline) && entry.debug.timeline.length > 0) {
        const compact = entry.debug.timeline.map((item) => `${item.stage}:${item.atMs}ms`).join(" -> ")
        lines.push(`timeline: ${compact}`)
      }
      if (entry.debug.promptExcerpt) lines.push(`prompt: ${entry.debug.promptExcerpt}`)
    }
    return lines.join("\n")
  }, [])

  const copyAssistantBubble = useCallback(async (entry: (typeof chatEngine.chatLog)[number]) => {
    const text = buildCopyPayload(entry)
    if (!text.trim()) return
    try {
      await navigator.clipboard.writeText(text)
      setCopiedDebugEntryId(entry.id)
      window.setTimeout(() => {
        setCopiedDebugEntryId((current) => (current === entry.id ? null : current))
      }, 1400)
    } catch {
      // no-op if clipboard API is unavailable or blocked
    }
  }, [buildCopyPayload])

  return (
    <div className="layout">
      <aside className="chat-panel" ref={chatPanelRef} style={chatPanelStyle}>
        <header className="chat-header">
          <div className="chat-header-top">
            <div className="chat-header-site-name">
              {activeSiteConfig.name} <a href="/sites" className="chat-header-switch-site">Switch</a>
            </div>
            {chatEngine.plannerBadgeState === "demo" ? (
              <span className="planner-badge planner-badge-demo">Demo mode</span>
            ) : chatEngine.plannerBadgeState === "openai" || chatEngine.plannerBadgeState === "anthropic" ? (
              <span className="planner-badge planner-badge-ai">AI</span>
            ) : null}
          </div>
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
                ref={settingsButtonRef}
              >
                <Settings2Icon size={16} color="currentColor" />
              </button>
              <button type="button" className="publish-preview-btn" onClick={() => void publish.publishSite()} disabled={chatEngine.isLoading || publish.isPublishing}>
                {publish.publishInProgress ? <span className="publish-spinner" aria-hidden="true" /> : null}
                {publish.publishInProgress ? "Publishing" : "Publish"}
              </button>
            </div>
            {publish.publishStatus ? (
              <>
                {publish.publishStatus.inspectUrl ? (
                  <a className="publish-view-link" href={publish.publishStatus.inspectUrl} target="_blank" rel="noreferrer">
                    View deploy
                  </a>
                ) : null}
                {liveSiteUrl ? (
                  <a className="publish-view-link" href={liveSiteUrl} target="_blank" rel="noreferrer">
                    Open live site
                  </a>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        <section className="chat-thread" ref={chatThreadRef}>
          {chatEngine.chatLog.map((entry) => (
            <article
              key={entry.id}
              className={`msg msg-${entry.role} ${entry.status === "needs_clarification" ? "msg-clarification" : ""} ${entry.canUndo ? "msg-has-undo" : ""}`}
            >
              <div className="msg-main">{entry.text}</div>
              {entry.aiJustification ? (
                <div className="msg-ai-insight">
                  <div className="msg-ai-insight-label">AI justification</div>
                  <blockquote>{entry.aiJustification}</blockquote>
                </div>
              ) : null}
              {entry.aiPerformanceNote ? (
                <div className="msg-ai-insight">
                  <div className="msg-ai-insight-label">Performance awareness</div>
                  <blockquote>{entry.aiPerformanceNote}</blockquote>
                </div>
              ) : null}
              {entry.status && !entry.canUndo && entry.status !== "needs_clarification" && entry.status !== "plan_ready" ? <div className="msg-status">{entry.status}</div> : null}
              {(entry.changes ?? []).filter((line) => !isRedundantChangeLine(entry.text, line)).length > 0 ? (
                <ul className="msg-list">
                  {(entry.changes ?? [])
                    .filter((line) => !isRedundantChangeLine(entry.text, line))
                    .map((line, idx) => (
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
                      onClick={() => void chatEngine.submitChat(line)}
                      disabled={chatEngine.isLoading}
                    >
                      {line}
                    </button>
                  ))}
                </div>
              ) : null}
              {entry.status === "plan_ready" && entry.pendingPlanId ? (
                <div className="msg-plan-actions">
                  {(() => {
                    const currentPlanId = entry.pendingPlanId
                    const disabled = chatEngine.isLoading || chatEngine.pendingPlanId !== currentPlanId
                    return (
                      <>
                  <button
                    type="button"
                    className="primary-btn msg-plan-btn"
                    onClick={() => void chatEngine.approvePendingPlan(currentPlanId)}
                    disabled={disabled}
                  >
                    Approve plan
                  </button>
                  <button
                    type="button"
                    className="secondary-btn msg-plan-btn"
                    onClick={() => void chatEngine.stopPendingPlan(currentPlanId)}
                    disabled={disabled}
                  >
                    Stop
                  </button>
                      </>
                    )
                  })()}
                </div>
              ) : null}
              {(() => {
                const routes = (entry.mentionedSlugs ?? []).filter((route) => route !== slug)
                if (routes.length === 0) return null
                return (
                  <div className="msg-suggestions msg-page-links">
                    {routes.map((route, idx) => (
                      <button
                        key={`${entry.id}-route-${idx}`}
                        type="button"
                        className="msg-suggestion msg-page-link"
                        onClick={() => {
                          setSlug(route)
                        }}
                        disabled={chatEngine.isLoading}
                      >
                        Open {route}
                      </button>
                    ))}
                  </div>
                )
              })()}
              {(entry.errors ?? []).length > 0 ? (
                <ul className="msg-errors">
                  {entry.errors?.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {showDebugDetails && entry.role === "assistant" && entry.debug ? (
                <div className="msg-debug">
                  <div className="msg-debug-title-row">
                    <div className="msg-debug-title">Debug</div>
                    <button
                      type="button"
                      className="msg-debug-copy-btn"
                      onClick={() => void copyAssistantBubble(entry)}
                      aria-label={copiedDebugEntryId === entry.id ? "Copied" : "Copy debug bubble"}
                      title={copiedDebugEntryId === entry.id ? "Copied" : "Copy"}
                    >
                      {copiedDebugEntryId === entry.id ? (
                        <Check aria-hidden="true" size={14} />
                      ) : (
                        <Copy aria-hidden="true" size={14} />
                      )}
                    </button>
                  </div>
                  <ul>
                    {entry.debug.traceId ? <li>traceId: {entry.debug.traceId}</li> : null}
                    {entry.debug.promptHash ? <li>promptHash: {entry.debug.promptHash}</li> : null}
                    {entry.debug.outcome ? <li>outcome: {entry.debug.outcome}</li> : null}
                    {entry.debug.reasonCategory ? <li>reason: {entry.debug.reasonCategory}</li> : null}
                    {entry.debug.intent ? <li>intent: {entry.debug.intent}</li> : null}
                    {typeof entry.debug.opCount === "number" ? <li>opCount: {entry.debug.opCount}</li> : null}
                    {typeof entry.debug.skippedOpCount === "number" && entry.debug.skippedOpCount > 0 ? <li>skippedOps: {entry.debug.skippedOpCount}</li> : null}
                    {Array.isArray(entry.debug.opTypes) && entry.debug.opTypes.length > 0 ? <li>ops: {entry.debug.opTypes.join(", ")}</li> : null}
                    {Array.isArray(entry.debug.timeline) && entry.debug.timeline.length > 0 ? (
                      <li>timeline: {entry.debug.timeline.map((item) => `${item.stage}:${item.atMs}ms`).join(" -> ")}</li>
                    ) : null}
                    {entry.debug.promptExcerpt ? <li>prompt: {entry.debug.promptExcerpt}</li> : null}
                  </ul>
                </div>
              ) : null}
              {entry.canUndo || entry.wasUndone ? (
                <div className="msg-undo-row">
                  <button
                    type="button"
                    className="msg-undo-btn"
                    onClick={() => void chatEngine.applyUndoHistory(entry.id)}
                    disabled={!entry.canUndo || chatEngine.isLoading || chatEngine.undoInFlightEntryId !== null}
                  >
                    <span>{entry.wasUndone ? "Undone" : "Undo"}</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 7 4 12l5 5" />
                      <path d="M5 12h7a4.5 4.5 0 0 1 0 9H10" />
                    </svg>
                  </button>
                </div>
              ) : null}
            </article>
          ))}
          {chatEngine.streamStatus ? (
            <div className={`streaming-pill ${streamIsError ? "is-error" : "is-active"} ${STREAMING_INDICATOR_STYLE === "text" ? "is-text" : "is-legacy"}`}>
              {STREAMING_INDICATOR_STYLE === "text" ? (
                <span className="streaming-pill-status streaming-pill-status-text">{streamTextLabel}</span>
              ) : (
                <>
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
                </>
              )}
              {chatEngine.latestStreamFocusBlockId ? (
                <button
                  type="button"
                  className="streaming-jump-btn"
                  onClick={() =>
                    preview.postToSite("highlightBlock", {
                      blockId: chatEngine.latestStreamFocusBlockId,
                      editablePath: null
                    })
                  }
                >
                  Jump to latest change
                </button>
              ) : null}
            </div>
          ) : null}
          <div />
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
          <ClaudeStyleChatInput
            message={message}
            isLoading={chatEngine.isLoading}
            modelKey={modelKey}
            provider={provider}
            availableProviders={availableProviders}
            hasUserEntry={hasUserEntry}
            onMessageChange={setMessage}
            onModelChange={setModelKey}
            onProviderChange={setProvider}
            onSubmit={(explicitMessage) => {
              setMessage("")
              void chatEngine.submitChat(explicitMessage, message)
            }}
            onTranscribeAudio={media.transcribeAudio}
            onInterpretImage={media.interpretPastedImage}
            onUploadImage={media.uploadPastedImage}
            onAutoHeightChange={handleComposerAutoHeight}
          />
        </footer>
      </aside>

      <section className="preview">
        <iframe
          ref={preview.iframeRef}
          title="Live preview"
          src={previewSrc}
          onLoad={() => preview.postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })}
        />
      </section>

      {chatEngine.variationModal ? (() => {
        const vm = chatEngine.variationModal
        return (
        <div
          className="variation-modal-backdrop"
          onClick={() => {
            if (!chatEngine.isApplyingVariation) chatEngine.setVariationModal(null)
          }}
        >
          <div className="variation-modal" role="dialog" aria-modal="true" aria-label="Choose a variation" onClick={(e) => e.stopPropagation()}>
            <div className="variation-modal-header">
              <h2>Choose a Variation</h2>
              <button
                type="button"
                className="settings-close-btn"
                aria-label="Close variation picker"
                onClick={() => chatEngine.setVariationModal(null)}
                disabled={chatEngine.isApplyingVariation}
              >
                ×
              </button>
            </div>
            <div className="variation-modal-body">
              {vm.options.map((option) => (
                <article key={option.id} className="variation-card">
                  <header className="variation-card-header">
                    <h3>{option.title}</h3>
                    <span>{option.changedKeys.join(", ") || "patch"}</span>
                  </header>
                  <p>{option.summary}</p>
                  <VariationScaledPreview
                    virtualWidth={previewPresetWidths.desktop}
                    block={{
                      id: vm.blockId,
                      type: vm.blockType as BlockInstance["type"],
                      props: mergedVariationProps(vm.baseProps, option.patch)
                    }}
                  />
                  <button type="button" className="publish-preview-btn variation-apply-btn" onClick={() => void chatEngine.applyVariation(option)} disabled={chatEngine.isApplyingVariation}>
                    {chatEngine.isApplyingVariation ? "Applying..." : "Apply this variation"}
                  </button>
                </article>
              ))}
            </div>
          </div>
        </div>
        )
      })() : null}

      {addBlockPicker ? (
        <div
          className="add-block-modal-backdrop"
          onClick={() => {
            if (!isAddingBlock) setAddBlockPicker(null)
          }}
        >
          <div className="add-block-modal" role="dialog" aria-modal="true" aria-label="Add block" onClick={(e) => e.stopPropagation()}>
            <div className="add-block-modal-header">
              <h2>Add block</h2>
              <p>
                {addBlockPicker.beforeBlockId && !addBlockPicker.afterBlockId
                  ? "Select block type to insert above the selected section."
                  : "Select block type to insert below the selected section."}
              </p>
              <button
                type="button"
                className="settings-close-btn"
                aria-label="Close add block picker"
                onClick={() => setAddBlockPicker(null)}
                disabled={isAddingBlock}
              >
                ×
              </button>
            </div>
            <div className="add-block-modal-body">
              <label className="add-block-search">
                <input
                  type="search"
                  value={addBlockSearch}
                  onChange={(e) => setAddBlockSearch(e.target.value)}
                  placeholder="Search block types"
                  disabled={isAddingBlock}
                />
              </label>
              {groupedBlockTypeOptions.length === 0 ? (
                <p className="add-block-empty">No block types match your search.</p>
              ) : (
                <div className="add-block-flat-list">
                  {groupedBlockTypeOptions.flatMap((group) => group.options).map((option) => (
                    <button
                      key={option.type}
                      type="button"
                      className="add-block-option"
                      disabled={isAddingBlock}
                      onClick={async () => {
                        if (!addBlockPicker || isAddingBlock) return
                        setIsAddingBlock(true)
                        const ok = await chatEngine.addBlockAfter(
                          addBlockPicker.slug,
                          addBlockPicker.afterBlockId,
                          option.type,
                          addBlockPicker.beforeBlockId
                        )
                        setIsAddingBlock(false)
                        if (ok) setAddBlockPicker(null)
                      }}
                    >
                      <span className="add-block-option-label">{option.label}</span>
                      <span className="add-block-option-actions" aria-hidden="true">
                        <span className="add-block-option-plus">+</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {showSettingsModal ? (
        <div className="settings-popover-backdrop" onClick={() => setShowSettingsModal(false)}>
          <div
            className="settings-modal settings-modal-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
            onClick={(e) => e.stopPropagation()}
            style={settingsPopoverPos ? { top: settingsPopoverPos.top, left: settingsPopoverPos.left } : undefined}
          >
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button type="button" className="settings-close-btn" aria-label="Close settings" onClick={() => setShowSettingsModal(false)}>
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <label className="inline-toggle">
                <input type="checkbox" checked={useStreaming} onChange={(e) => setUseStreaming(e.target.checked)} />
                <span>Streaming</span>
              </label>

              <label className="inline-toggle">
                <input type="checkbox" checked={showNestedLabels} onChange={(e) => setShowNestedLabels(e.target.checked)} />
                <span>Nested labels</span>
              </label>
              <label className="inline-toggle">
                <input type="checkbox" checked={chatDarkMode} onChange={(e) => onSetChatDarkMode(e.target.checked)} />
                <span>Dark mode</span>
              </label>
              <label className="inline-toggle">
                <input type="checkbox" checked={showDebugDetails} onChange={(e) => setShowDebugDetails(e.target.checked)} />
                <span>Debug mode</span>
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
