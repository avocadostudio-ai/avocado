import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Bot, Check, Copy, Ellipsis, ExternalLink, Settings, SlidersHorizontal, Sparkles } from "lucide-react"
import ClaudeStyleChatInput from "./components/claude-style-chat-input"
import Settings2Icon from "./components/settings2-icon"
import { VariationScaledPreview } from "./components/VariationScaledPreview"
import { SitesPage } from "./components/SitesPage"
import { ImagePickerModal } from "./components/ImagePickerModal"
import { useSiteList } from "./hooks/useSiteList"
import { usePreviewBridge, type PreviewBridgeCallbacks } from "./hooks/usePreviewBridge"
import { useChatEngine } from "./hooks/useChatEngine"
import { usePublish } from "./hooks/usePublish"
import { useMediaInput } from "./hooks/useMediaInput"
import { useBlockProps } from "./hooks/useBlockProps"
import { PropertyPanel } from "./components/PropertyPanel"
import { useComponentManifest } from "./hooks/useComponentManifest"
import { resolveStreamingIndicatorStyle } from "./config/streaming-indicator"
import { allowedBlockTypes, getAllBlockMeta, isImagePath, toAltPath, type BlockInstance } from "@ai-site-editor/shared"
import type { AIProvider, ChatEntry, ModelKey, PlannerSource } from "./lib/editor-types"
import { fieldAiSuggestions } from "./lib/field-ai-suggestions"
import { manifestUnavailableChanges } from "./lib/integration-context"
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
  resolveSiteOrigin,
  resolveDefaultChatDarkMode,
  resolveDefaultDebugMode,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  resolveEditorSiteId,
  slugLabel
} from "./lib/editor-utils"

const STREAMING_INDICATOR_STYLE = resolveStreamingIndicatorStyle()

const MODEL_LABELS: Record<AIProvider, Record<ModelKey, string>> = {
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", reasoning: "o1", codex: "o3" },
  anthropic: { fast: "Haiku", balanced: "Sonnet", reasoning: "Sonnet+Thinking", codex: "Opus" },
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
}

function selectionValue(provider: AIProvider, model: ModelKey) {
  return `${provider}:${model}`
}

function renderSimpleMarkdown(text: string) {
  const lines = text.split("\n")
  const elements: (React.ReactNode)[] = []
  let listItems: string[] = []

  const flushList = () => {
    if (listItems.length === 0) return
    elements.push(
      <ul key={`ul-${elements.length}`}>
        {listItems.map((item, i) => (
          <li key={i}>{inlineMarkdown(item)}</li>
        ))}
      </ul>
    )
    listItems = []
  }

  const inlineMarkdown = (line: string) => {
    const parts: (React.ReactNode)[] = []
    const regex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) {
      if (match.index > last) parts.push(line.slice(last, match.index))
      if (match[1] !== undefined) parts.push(<strong key={match.index}>{match[1]}</strong>)
      else if (match[2] !== undefined) parts.push(<em key={match.index}>{match[2]}</em>)
      else if (match[3] !== undefined) parts.push(<code key={match.index}>{match[3]}</code>)
      last = match.index + match[0].length
    }
    if (last < line.length) parts.push(line.slice(last))
    return parts.length === 1 ? parts[0] : <>{parts}</>
  }

  for (const line of lines) {
    const listMatch = /^\s*[-*•]\s+(.+)$/.exec(line)
    if (listMatch) {
      listItems.push(listMatch[1])
      continue
    }
    flushList()
    if (line.trim() === "") {
      continue
    }
    elements.push(<p key={`p-${elements.length}`}>{inlineMarkdown(line)}</p>)
  }
  flushList()

  return <>{elements}</>
}

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
  const activeSiteOrigin = useMemo(() => resolveSiteOrigin(activeSiteConfig), [activeSiteConfig])
  const componentManifest = useComponentManifest(activeSiteOrigin)

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
  const [composerHeight, setComposerHeight] = useState(56)
  const [settingsPopoverPos, setSettingsPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const [addBlockPicker, setAddBlockPicker] = useState<{ slug: string; afterBlockId?: string; beforeBlockId?: string } | null>(null)
  const [addBlockSearch, setAddBlockSearch] = useState("")
  const [isAddingBlock, setIsAddingBlock] = useState(false)
  const [copiedDebugEntryId, setCopiedDebugEntryId] = useState<string | null>(null)
  const [selectedVariationId, setSelectedVariationId] = useState<string | null>(null)
  const [imagePickerTarget, setImagePickerTarget] = useState<{ slug: string; blockId: string; editablePath: string; currentUrl?: string } | null>(null)
  const imagePickerOpen = imagePickerTarget !== null
  const [backendFeatures, setBackendFeatures] = useState<{ googleDrive?: boolean; unsplash?: boolean; imageGenerate?: boolean }>({})
  const [activeTab, setActiveTab] = useState<"chat" | "properties">("chat")
  const [siteConfigTab, setSiteConfigTab] = useState<"overview" | "tone" | "constraints">("overview")
  const [configModalTab, setConfigModalTab] = useState<"general" | "brief" | "deploy">("general")
  const [driveValidation, setDriveValidation] = useState<{ status: "loading" | "ok" | "error"; message?: string } | null>(null)
  useEffect(() => { if (!sites.configSiteId) { setDriveValidation(null); setSiteConfigTab("overview") } }, [sites.configSiteId])

  const chatPanelRef = useRef<HTMLElement>(null)
  const chatThreadRef = useRef<HTMLElement>(null)
  const splitHandleRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const settingsPopoverRef = useRef<HTMLDivElement>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const lastStructuralNoticeAtRef = useRef(0)
  const resizeStartRef = useRef<{ y: number; composerHeight: number } | null>(null)

  const routeOptions = useMemo(() => {
    const raw = Array.from(new Set([...availableSlugs, slug].filter(Boolean)))
    return raw.includes("/") ? ["/", ...raw.filter((route) => route !== "/")] : raw
  }, [availableSlugs, slug])

  const blockTypeOptions = useMemo(() => {
    if (!componentManifest.allowStructuralEdits) return []
    if (componentManifest.components.length > 0) {
      return componentManifest.components
        .map((item) => ({
          type: item.type,
          label: item.displayName ?? item.type,
          category: "content" as const
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
    }
    const meta = getAllBlockMeta()
    return [...allowedBlockTypes]
      .map((type) => ({
        type,
        label: meta[type]?.displayName ?? type,
        category: meta[type]?.category ?? "content"
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [componentManifest.allowStructuralEdits, componentManifest.components])

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

  const notifyStructuralUnavailable = () => {
    const now = Date.now()
    if (now - lastStructuralNoticeAtRef.current < 1200) return
    lastStructuralNoticeAtRef.current = now
    chatEngine.pushAssistantFromResult({
      status: "needs_clarification",
      summary: "Structural edits are disabled for this site context.",
      changes: manifestUnavailableChanges(componentManifest.reason)
    })
  }

  const previewCallbacks = useMemo<PreviewBridgeCallbacks>(() => ({
    onBlockClicked: (newSlug, blockId, blockType, editablePath, editableValue) => {
      setSlug(newSlug)
      activeBlockIdRef.current = blockId
      activeBlockTypeRef.current = blockType
      activeEditablePathRef.current = editablePath
      setActiveBlockId(blockId)
      setActiveBlockType(blockType)
      setActiveEditablePath(editablePath)
      if (blockId) preview.postToSite("highlightBlock", { blockId, editablePath: editablePath ?? null })
      // Open image picker when an image field is clicked
      if (blockId && editablePath && isImagePath(editablePath)) {
        setImagePickerTarget({ slug: newSlug, blockId, editablePath, currentUrl: editableValue })
      }
    },
    onRouteChanged: (newSlug) => {
      setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
    },
    onBlockReordered: (newSlug, blockId, afterBlockId) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.reorderBlock(newSlug, blockId, afterBlockId)
    },
    onBlockDeleteRequested: (newSlug, blockId) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.deleteBlock(newSlug, blockId)
    },
    onBlockAddRequested: (newSlug, args) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlug(newSlug)
      if (!args.afterBlockId && !args.beforeBlockId) return
      setAddBlockPicker({ slug: newSlug, afterBlockId: args.afterBlockId, beforeBlockId: args.beforeBlockId })
    },
    onListItemAddRequested: (newSlug, blockId, blockType, listKey, afterIndex) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.addListItem(newSlug, blockId, blockType, listKey, afterIndex)
    },
    onListItemRemoveRequested: (newSlug, blockId, blockType, listKey, index) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlug(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.removeListItem(newSlug, blockId, blockType, listKey, index)
    },
    onListItemMoveRequested: (newSlug, blockId, blockType, listKey, index, afterIndex) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
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
  }), [componentManifest.allowStructuralEdits, slug])

  const preview = usePreviewBridge(slug, previewCallbacks, activeSiteOrigin)

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
    routeOptions,
    componentManifest: componentManifest.manifest,
    siteCapabilities: componentManifest.siteCapabilities,
    allowStructuralEdits: componentManifest.allowStructuralEdits,
    getBlockDefaultProps: (blockType) => componentManifest.byType.get(blockType)?.defaultProps ?? null
  })

  const publish = usePublish(session, siteId, chatEngine.isLoading, chatEngine.pushAssistantFromResult)

  const media = useMediaInput()

  const blockProps = useBlockProps(session, siteId, slug, activeBlockId, activeTab === "properties")

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

  // Preview src — uses per-site previewUrl when available, falls back to VITE_SITE_ORIGIN
  const previewSrc = useMemo(() => {
    return buildSiteDraftEnableUrl(slug, {
      session,
      siteId,
      editorOrigin
    }, activeSiteOrigin)
  }, [activeSiteOrigin, editorOrigin, session, siteId, slug])

  const liveSiteUrl = useMemo(() => {
    const configured = activeSiteConfig.vercelProductionUrl?.trim()
    const base = configured && /^https?:\/\//i.test(configured) ? configured : activeSiteOrigin
    try {
      const url = new URL(base)
      if (url.origin === activeSiteOrigin) {
        return buildSiteDraftDisableUrl(slug, {}, activeSiteOrigin)
      }
      url.pathname = slug === "/" ? "/" : slug
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return undefined
    }
  }, [activeSiteConfig.vercelProductionUrl, activeSiteOrigin, slug])

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
          const data = (await res.json()) as { plannerSource?: PlannerSource; availableProviders?: AIProvider[]; features?: { googleDrive?: boolean; unsplash?: boolean; imageGenerate?: boolean } }
          if (!active) return
          if (data.features) {
            setBackendFeatures((prev) => {
              if (prev.googleDrive === data.features!.googleDrive &&
                  prev.unsplash === data.features!.unsplash &&
                  prev.imageGenerate === data.features!.imageGenerate) return prev
              return data.features!
            })
          }
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
  }, [chatEngine.chatLog, chatEngine.streamStatus, chatEngine.streamingText])

  // Nested labels sync
  useEffect(() => {
    preview.postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
  }, [showNestedLabels])

  // Highlight active block sync
  useEffect(() => {
    if (!activeBlockId) return
    preview.postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  // Auto-switch to Properties tab when a block is selected (unless user is typing),
  // and clear any field-AI context entries from a previous block
  useEffect(() => {
    if (activeBlockId && !message.trim()) setActiveTab("properties")
    chatEngine.clearFieldAiContext()
  }, [activeBlockId])

  const handleFieldAiAssist = useCallback((fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string) => {
    if (!activeBlockId || !activeBlockType) return
    const allMeta = getAllBlockMeta()
    const blockDisplayName = allMeta[activeBlockType]?.displayName ?? activeBlockType

    setActiveEditablePath(fieldPath)
    setActiveTab("chat")

    const suggestions = fieldAiSuggestions(fieldKind, fieldLabel, activeBlockType, currentValue)
    const entry: ChatEntry = {
      id: `field-ai-${Date.now()}`,
      role: "assistant",
      text: `Editing: ${blockDisplayName} → ${fieldLabel}`,
      fieldAiContext: { blockId: activeBlockId, blockType: activeBlockType, fieldPath, fieldLabel, blockDisplayName },
      suggestions
    }

    chatEngine.setFieldAiContext(entry)
  }, [activeBlockId, activeBlockType])

  // Refresh slugs on session/site change
  useEffect(() => { void chatEngine.refreshRouteSlugs() }, [session, siteId])

  // Composer resize
  const clampComposerHeight = (value: number) => {
    const minComposer = 56
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
      const popover = settingsPopoverRef.current
      if (!button) return
      const rect = button.getBoundingClientRect()
      const gap = 8
      const minEdge = 8
      const popoverWidth = popover?.offsetWidth ?? Math.min(360, window.innerWidth - minEdge * 2)
      const popoverHeight = popover?.offsetHeight ?? 320
      const maxLeft = Math.max(minEdge, window.innerWidth - popoverWidth - minEdge)
      const left = Math.min(maxLeft, Math.max(minEdge, rect.right - popoverWidth))

      const spaceBelow = window.innerHeight - rect.bottom - minEdge
      const spaceAbove = rect.top - minEdge
      const preferredTop = rect.bottom + gap
      const preferredTopAbove = rect.top - popoverHeight - gap
      const topCandidate = spaceBelow < popoverHeight + gap && spaceAbove > spaceBelow ? preferredTopAbove : preferredTop

      const maxTop = Math.max(minEdge, window.innerHeight - popoverHeight - minEdge)
      const top = Math.min(maxTop, Math.max(minEdge, topCandidate))
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
    if (chatEngine.variationModal?.options.length) {
      setSelectedVariationId(chatEngine.variationModal.options[0].id)
    } else {
      setSelectedVariationId(null)
    }
  }, [chatEngine.variationModal])

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
  const streamLabel = chatEngine.imageProgress ? chatEngine.imageProgress.stage : (chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? "Shaping your update..." : "Getting things ready..."))
  const streamTextLabel = chatEngine.imageProgress ? chatEngine.imageProgress.stage : (chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? "Updating..." : "Thinking"))
  const chatPanelStyle = { "--composer-height": `${composerHeight}px` } as CSSProperties
  const hasUserEntry = chatEngine.chatLog.some((entry) => entry.role === "user")
  const buildCopyPayload = useCallback((entry: (typeof chatEngine.chatLog)[number]) => {
    const lines: string[] = []
    if (entry.text) lines.push(entry.text)
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
              {activeSiteConfig.name} <a href="/sites" className="chat-header-switch-site">All sites</a>
            </div>
            <div className="chat-header-right">
              {componentManifest.status === "degraded" ? (
                <span className="planner-badge" title={componentManifest.reason ?? "Components unavailable"}>
                  Limited
                </span>
              ) : null}
              {chatEngine.plannerBadgeState === "demo" ? (
                <span className="planner-badge planner-badge-demo">Demo mode</span>
              ) : null}
              <button
                type="button"
                className="chat-header-icon-btn"
                aria-label="Site settings"
                title="Site settings"
                onClick={() => sites.setConfigSiteId(siteId)}
              >
                <Settings size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="chat-header-icon-btn"
                aria-label="More options"
                onClick={() => setShowSettingsModal(true)}
                ref={settingsButtonRef}
              >
                <Ellipsis size={14} aria-hidden="true" />
              </button>
            </div>
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
                  <a
                    className="live-site-icon-btn"
                    href={liveSiteUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open live site"
                    title="Open live site"
                  >
                    <ExternalLink size={16} aria-hidden="true" />
                  </a>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        <nav className="panel-tabs">
          <button type="button" className={`panel-tab ${activeTab === "chat" ? "is-active" : ""}`} onClick={() => setActiveTab("chat")}><Bot size={14} /> Chat</button>
          <button type="button" className={`panel-tab ${activeTab === "properties" ? "is-active" : ""}`} onClick={() => setActiveTab("properties")}>
            <SlidersHorizontal size={14} /> Properties{activeBlockId ? <span className="panel-tab-dot" /> : null}
          </button>
        </nav>

        <section className="chat-thread" ref={chatThreadRef} style={{ display: activeTab === "chat" ? "" : "none" }}>
          {chatEngine.chatLog.map((entry) => (
            <article
              key={entry.id}
              className={`msg msg-${entry.role} ${entry.status === "needs_clarification" ? "msg-clarification" : ""} ${entry.canUndo ? "msg-has-undo" : ""} ${entry.fieldAiContext ? "msg-field-context" : ""}`}
            >
              <div className="msg-main">{entry.role === "assistant" ? renderSimpleMarkdown(entry.text) : entry.text}</div>
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
              {entry.continuation ? (
                <div className="msg-plan-actions">
                  <button
                    type="button"
                    className="primary-btn msg-plan-btn"
                    onClick={() => void chatEngine.continueChain(entry.continuation!.chainId)}
                    disabled={chatEngine.isLoading || chatEngine.continuationChainId !== entry.continuation.chainId}
                  >
                    Continue: {entry.continuation.nextStepLabel} ({entry.continuation.currentStep} of {entry.continuation.totalSteps})
                  </button>
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
          {chatEngine.streamingText ? (
            <article className="msg msg-assistant msg-streaming">
              {chatEngine.streamSteps.filter((s) => s.done).length > 0 ? (
                <ul className="stream-steps stream-steps-in-bubble">
                  {chatEngine.streamSteps.filter((s) => s.done).map((step, idx) => (
                    <li key={idx} className="stream-step is-done">{step.label}</li>
                  ))}
                </ul>
              ) : null}
              <div className="msg-main">
                {renderSimpleMarkdown(chatEngine.streamingText)}
                <span className="streaming-cursor" aria-hidden="true" />
              </div>
              {chatEngine.streamingChanges.length > 0 ? (
                <ul className="msg-list">
                  {chatEngine.streamingChanges.map((line, idx) => (
                    <li key={idx}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {chatEngine.streamStatus ? (
                <span className="streaming-pill-status streaming-pill-status-text stream-status-inline">{streamTextLabel}</span>
              ) : null}
            </article>
          ) : chatEngine.streamStatus ? (
            <div className={`streaming-pill ${streamIsError ? "is-error" : "is-active"} ${STREAMING_INDICATOR_STYLE === "text" ? "is-text" : "is-legacy"}`}>
              {STREAMING_INDICATOR_STYLE === "text" ? (
                <>
                  {chatEngine.streamSteps.filter((s) => s.done).length > 0 ? (
                    <ul className="stream-steps">
                      {chatEngine.streamSteps.filter((s) => s.done).map((step, idx) => (
                        <li key={idx} className="stream-step is-done">{step.label}</li>
                      ))}
                    </ul>
                  ) : null}
                  <span className="streaming-pill-status streaming-pill-status-text">{streamTextLabel}</span>
                </>
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
              {chatEngine.imageProgress ? (
                <div className="image-gen-progress">
                  <div className="image-gen-progress-fill" style={{ width: `${chatEngine.imageProgress.percent}%` }} />
                </div>
              ) : null}
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

        <PropertyPanel
          style={{ display: activeTab === "properties" ? "" : "none" }}
          blockId={activeBlockId}
          blockType={activeBlockType}
          props={blockProps.props}
          status={blockProps.status}
          slug={slug}
          navLabel={sites.headerConfig.navLabels?.[slug] ?? ""}
          onNavLabelChange={(s, label) => {
            void sites.updateHeaderConfig({ navLabels: { [s]: label } })
            preview.postToSite("draftUpdated", {})
          }}
          onFieldChange={async (path, value) => {
            await chatEngine.inlineEditCommit(slug, activeBlockId!, path, value, { silent: true })
            void blockProps.refetch()
          }}
          onImageClick={(fieldPath, currentUrl) => {
            if (!activeBlockId) return
            setImagePickerTarget({ slug, blockId: activeBlockId, editablePath: fieldPath, currentUrl })
          }}
          onAiAssist={handleFieldAiAssist}
        />

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
            hasUserEntry={hasUserEntry}
            onMessageChange={setMessage}
            onSubmit={(explicitMessage) => {
              setMessage("")
              void chatEngine.submitChat(explicitMessage, message)
            }}
            onTranscribeAudio={media.transcribeAudio}
            onInterpretImage={media.interpretPastedImage}
            onUploadImage={media.uploadPastedImage}
            onCancel={chatEngine.cancelChat}
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
        const selectedOption = vm.options.find((o) => o.id === selectedVariationId) ?? null
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
              {vm.options.map((option, idx) => (
                <article
                  key={option.id}
                  className={`variation-card${option.id === selectedVariationId ? " is-selected" : ""}`}
                  onClick={() => setSelectedVariationId(option.id)}
                >
                  <div className="variation-card-preview-wrap">
                    <span className="variation-card-badge">{String.fromCharCode(65 + idx)}</span>
                    <VariationScaledPreview
                      virtualWidth={previewPresetWidths.desktop}
                      block={{
                        id: vm.blockId,
                        type: vm.blockType as BlockInstance["type"],
                        props: mergedVariationProps(vm.baseProps, option.patch)
                      }}
                    />
                  </div>
                  <h3 className="variation-card-title">{option.title}</h3>
                  <p className="variation-card-summary">{option.summary}</p>
                </article>
              ))}
            </div>
            <div className="variation-modal-footer">
              <button
                type="button"
                className="publish-preview-btn variation-apply-btn"
                onClick={() => { if (selectedOption) void chatEngine.applyVariation(selectedOption) }}
                disabled={chatEngine.isApplyingVariation || !selectedOption}
              >
                {chatEngine.isApplyingVariation ? "Applying..." : `Apply "${selectedOption?.title ?? ""}"`}
              </button>
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
                        const defaultProps = componentManifest.byType.get(option.type)?.defaultProps
                        const ok = await chatEngine.addBlockAfter(
                          addBlockPicker.slug,
                          addBlockPicker.afterBlockId,
                          option.type,
                          addBlockPicker.beforeBlockId,
                          defaultProps
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
            ref={settingsPopoverRef}
            className="settings-modal settings-modal-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Developer mode"
            onClick={(e) => e.stopPropagation()}
            style={settingsPopoverPos ? { top: settingsPopoverPos.top, left: settingsPopoverPos.left } : undefined}
          >
            <div className="settings-modal-header">
              <h2>Developer mode</h2>
              <button type="button" className="settings-close-btn" aria-label="Close" onClick={() => setShowSettingsModal(false)}>
                ×
              </button>
            </div>
            <div className="settings-modal-body">
              <div className="settings-toggle-list" role="group" aria-label="Developer toggles">
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
              <label className="settings-model-picker">
                <span className="settings-field-label">Model</span>
                <select
                  value={selectionValue(provider, modelKey)}
                  onChange={(e) => {
                    const [nextProvider, nextModel] = e.target.value.split(":") as [AIProvider, ModelKey]
                    setProvider(nextProvider)
                    setModelKey(nextModel)
                  }}
                  aria-label="Select AI model"
                >
                  {(availableProviders.length > 0 ? availableProviders : [provider]).flatMap((p) =>
                    (Object.keys(MODEL_LABELS[p]) as ModelKey[]).map((m) => (
                      <option key={selectionValue(p, m)} value={selectionValue(p, m)}>
                        {PROVIDER_LABELS[p]} {MODEL_LABELS[p][m]}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button type="button" className="settings-link-btn settings-link-btn-danger" onClick={() => { chatEngine.clearChat(); setShowSettingsModal(false) }}>
                Clear chat
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sites.configSite ? (
        <div className="sites-modal-backdrop" onClick={() => sites.setConfigSiteId(null)}>
          <section className="sites-modal" role="dialog" aria-modal="true" aria-label="Site config" onClick={(e) => e.stopPropagation()}>
            <header className="sites-modal-header">
              <h2>Site Config</h2>
              <button type="button" className="settings-close-btn" onClick={() => sites.setConfigSiteId(null)} aria-label="Close">
                ×
              </button>
            </header>
            <nav className="panel-tabs">
              <button type="button" className={`panel-tab ${configModalTab === "general" ? "is-active" : ""}`} onClick={() => setConfigModalTab("general")}>General</button>
              <button type="button" className={`panel-tab ${configModalTab === "brief" ? "is-active" : ""}`} onClick={() => setConfigModalTab("brief")}>Brief</button>
              <button type="button" className={`panel-tab ${configModalTab === "deploy" ? "is-active" : ""}`} onClick={() => setConfigModalTab("deploy")}>Deploy</button>
            </nav>
            <div className="sites-modal-body">
              {configModalTab === "general" ? (
                <div className="sites-form-grid">
                  <label className="sites-form-field">
                    <span>Site name</span>
                    <input
                      type="text"
                      value={sites.configSite.name}
                      placeholder="Site name"
                      onChange={(e) => sites.updateConfigSite({ name: e.target.value })}
                    />
                  </label>
                  <p className="sites-form-section-title">Header</p>
                  <label className="sites-form-field">
                    <span>Header name</span>
                    <input
                      type="text"
                      value={sites.headerConfig.name ?? ""}
                      placeholder="Site header name"
                      onBlur={(e) => {
                        void sites.updateHeaderConfig({ name: e.target.value })
                        preview.postToSite("draftUpdated", {})
                      }}
                      onChange={(e) => sites.updateHeaderConfig({ name: e.target.value })}
                    />
                  </label>
                  <label className="sites-form-field">
                    <span>Logo URL</span>
                    <input
                      type="text"
                      value={sites.headerConfig.logo ?? ""}
                      placeholder="https://example.com/logo.svg"
                      onBlur={(e) => {
                        void sites.updateHeaderConfig({ logo: e.target.value })
                        preview.postToSite("draftUpdated", {})
                      }}
                      onChange={(e) => sites.updateHeaderConfig({ logo: e.target.value })}
                    />
                  </label>
                </div>
              ) : null}
              {configModalTab === "brief" ? (
                <div className="sites-form-grid">
                  <div className="sites-form-field sites-form-field-wide">
                    <div className="sites-ai-tabs" role="tablist" aria-label="Editorial brief tabs">
                      <button type="button" className={siteConfigTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("overview")}>Overview</button>
                      <button type="button" className={siteConfigTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("tone")}>Tone</button>
                      <button type="button" className={siteConfigTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("constraints")}>Constraints</button>
                    </div>
                    {siteConfigTab === "overview" ? (
                      <label className="sites-form-field">
                        <span>Overview</span>
                        <textarea value={sites.configSite.purpose} placeholder="What this site is for." onChange={(e) => sites.updateConfigSite({ purpose: e.target.value })} rows={8} />
                      </label>
                    ) : null}
                    {siteConfigTab === "tone" ? (
                      <label className="sites-form-field">
                        <span>Preferred tone</span>
                        <textarea value={sites.configSite.tone ?? ""} placeholder="How the writing should sound." onChange={(e) => sites.updateConfigSite({ tone: e.target.value })} rows={8} />
                      </label>
                    ) : null}
                    {siteConfigTab === "constraints" ? (
                      <label className="sites-form-field">
                        <span>Writing constraints</span>
                        <textarea
                          value={(sites.configSite.constraints ?? []).join("\n")}
                          placeholder={"Rules for content output.\nOne per line."}
                          onChange={(e) => sites.updateConfigSite({ constraints: e.target.value.split(/\n|,/g).map((s) => s.trim()).filter(Boolean) })}
                          rows={8}
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {configModalTab === "deploy" ? (
                <div className="sites-form-grid">
                  <div className="sites-settings-grid">
                    <label className="sites-form-field">
                      <span>Hosting</span>
                      <input type="text" value={sites.configSite.hosting} placeholder="Vercel production site" onChange={(e) => sites.updateConfigSite({ hosting: e.target.value })} />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel project ID</span>
                      <input type="text" value={sites.configSite.vercelProjectId ?? ""} placeholder="prj_..." onChange={(e) => sites.updateConfigSite({ vercelProjectId: e.target.value })} />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel team ID</span>
                      <input type="text" value={sites.configSite.vercelTeamId ?? ""} placeholder="team_..." onChange={(e) => sites.updateConfigSite({ vercelTeamId: e.target.value })} />
                    </label>
                    <label className="sites-form-field">
                      <span>Vercel production URL</span>
                      <input type="url" value={sites.configSite.vercelProductionUrl ?? ""} placeholder="https://example.vercel.app" onChange={(e) => sites.updateConfigSite({ vercelProductionUrl: e.target.value })} />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>Vercel deploy hook URL</span>
                      <input type="url" value={sites.configSite.vercelDeployHookUrl ?? ""} placeholder="https://api.vercel.com/v1/integrations/deploy/..." onChange={(e) => sites.updateConfigSite({ vercelDeployHookUrl: e.target.value })} />
                    </label>
                    <label className="sites-form-field sites-form-field-wide">
                      <span>Google Drive folder ID</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                          type="text"
                          value={sites.configSite.gdriveFolderId ?? ""}
                          placeholder="e.g. 1aBcDeFgHiJkLmNoPqRsTuVwXyZ"
                          onChange={(e) => { sites.updateConfigSite({ gdriveFolderId: e.target.value }); setDriveValidation(null) }}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="secondary-btn"
                          style={{ whiteSpace: "nowrap", padding: "6px 12px", fontSize: 13 }}
                          disabled={!sites.configSite.gdriveFolderId?.trim() || driveValidation?.status === "loading"}
                          onClick={async () => {
                            const folderId = sites.configSite!.gdriveFolderId?.trim()
                            if (!folderId) return
                            setDriveValidation({ status: "loading" })
                            try {
                              const res = await fetch(`${orchestrator}/gdrive/images?folderId=${encodeURIComponent(folderId)}&limit=1`)
                              if (res.ok) {
                                const data = (await res.json()) as { items: unknown[] }
                                setDriveValidation({ status: "ok", message: `Connected (${data.items.length > 0 ? "images found" : "folder empty"})` })
                              } else {
                                const data = (await res.json().catch(() => ({}))) as { error?: string }
                                setDriveValidation({ status: "error", message: data.error ?? `HTTP ${res.status}` })
                              }
                            } catch {
                              setDriveValidation({ status: "error", message: "Could not reach orchestrator" })
                            }
                          }}
                        >
                          {driveValidation?.status === "loading" ? "Testing..." : "Test"}
                        </button>
                      </div>
                      {driveValidation && driveValidation.status !== "loading" && (
                        <span style={{ fontSize: 12, marginTop: 4, color: driveValidation.status === "ok" ? "#4ade80" : "#f87171" }}>
                          {driveValidation.message}
                        </span>
                      )}
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
            <footer className="sites-modal-footer">
              <button type="button" className="primary-btn" onClick={() => sites.setConfigSiteId(null)}>Done</button>
            </footer>
          </section>
        </div>
      ) : null}

      <ImagePickerModal
        open={imagePickerOpen}
        features={{ ...backendFeatures, googleDrive: backendFeatures.googleDrive || Boolean(activeSiteConfig.gdriveFolderId?.trim()) }}
        currentUrl={imagePickerTarget?.currentUrl}
        gdriveFolderId={activeSiteConfig.gdriveFolderId}
        onClose={() => setImagePickerTarget(null)}
        onSelect={(imageUrl, alt) => {
          if (!imagePickerTarget) return
          const { slug: targetSlug, blockId, editablePath } = imagePickerTarget
          const altPath = toAltPath(editablePath)
          // Detect indexed list paths like "cards[0].imageUrl" → use update_item
          const listMatch = editablePath.match(/^([a-zA-Z_]+)\[(\d+)\]\.(.+)$/)
          const altListMatch = altPath !== editablePath ? altPath.match(/^([a-zA-Z_]+)\[(\d+)\]\.(.+)$/) : null
          let ops: Record<string, unknown>[]
          if (listMatch) {
            const [, listKey, indexStr, fieldKey] = listMatch
            const itemPatch: Record<string, string> = { [fieldKey]: imageUrl }
            if (altListMatch) itemPatch[altListMatch[3]] = alt
            ops = [{ op: "update_item", pageSlug: targetSlug, blockId, listKey, index: Number(indexStr), patch: itemPatch }]
          } else {
            const patch: Record<string, string> = { [editablePath]: imageUrl }
            if (altPath !== editablePath) patch[altPath] = alt
            ops = [{ op: "update_props", pageSlug: targetSlug, blockId, patch }]
          }
          void (async () => {
            try {
              const res = await fetch(`${orchestrator}/ops`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ session, siteId, ops })
              })
              const data = (await res.json()) as { status?: string; previewVersion?: number; error?: string }
              if (res.ok && data.status === "applied") {
                preview.postToSite("draftUpdated", { focusBlockId: blockId })
                chatEngine.pushAssistantFromResult({ status: "applied", summary: "Changed image." }, { canUndo: true })
                void blockProps.refetch()
              }
            } catch { /* ignore */ }
          })()
        }}
      />
    </div>
  )
}
