import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Bot, Check, ChevronDown, Copy, Ellipsis, ExternalLink, RefreshCw, Settings, SlidersHorizontal, ThumbsUp, ThumbsDown } from "lucide-react"
import ClaudeStyleChatInput from "./components/claude-style-chat-input"
import { ChatComposerCore, ChatThreadCore } from "./components/ChatSurface"
import Settings2Icon from "./components/settings2-icon"
import { SettingsModal } from "./components/SettingsModal"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { VariationScaledPreview } from "./components/VariationScaledPreview"
import { SitesPage } from "./components/SitesPage"
import { ImagePickerModal } from "./components/ImagePickerModal"
import { useSiteList } from "./hooks/useSiteList"
import { usePreviewBridge, type PreviewBridgeCallbacks, type AnchorRect } from "./hooks/usePreviewBridge"
import { useChatEngine } from "./hooks/useChatEngine"
import { usePublish } from "./hooks/usePublish"
import { useMediaInput } from "./hooks/useMediaInput"
import { useBlockProps } from "./hooks/useBlockProps"
import { usePageMeta } from "./hooks/usePageMeta"
import { PropertyPanel } from "./components/PropertyPanel"
import { useBlockManifest } from "./hooks/useBlockManifest"
import { resolveStreamingIndicatorStyle } from "./config/streaming-indicator"
import { allowedBlockTypes, getAllBlockMeta, toAltPath, type BlockInstance } from "@ai-site-editor/shared"
import type { AIProvider, ChatEntry, ModelKey, PlannerSource } from "./lib/editor-types"
import { useT } from "./i18n"
import { fieldAiSuggestions, fieldAiQuickActions } from "./lib/field-ai-suggestions"
import { manifestUnavailableChanges, withIntegrationContext } from "./lib/integration-context"
import {
  DEBUG_MODE_STORAGE_KEY,
  MODEL_KEY_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  CHAT_THEME_STORAGE_KEY,
  buildSitePathWithQuery,
  isRedundantChangeLine,
  mergedVariationProps,
  orchestrator,
  previewPresetWidths,
  buildSiteDraftDisableUrl,
  buildSiteDraftEnableUrl,
  resolveSiteOrigin,
  siteDraftSecret,
  resolveDefaultChatDarkMode,
  resolveDefaultDebugMode,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  resolveEditorSiteId,
  resolveAnchoredComposerEnabled,
  slugLabel
} from "./lib/editor-utils"

const STREAMING_INDICATOR_STYLE = resolveStreamingIndicatorStyle()
const PuckChatPrototype = lazy(
  () => import("./components/PuckPrototypeRoute").then((mod) => ({ default: mod.PuckPrototypeRoute }))
)
const PUCK_ROUTE_PATHS = new Set(["/editor/puck", "/editor/puck/"])

function isPuckRouteEnabled() {
  const raw = (import.meta.env.VITE_ENABLE_PUCK as string | undefined)?.trim().toLowerCase() ?? ""
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on"
}

const MODEL_LABELS: Record<AIProvider, Record<ModelKey, string>> = {
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", reasoning: "o1", codex: "o3" },
  anthropic: { fast: "Haiku", balanced: "Sonnet", reasoning: "Sonnet+Thinking", codex: "Opus" },
  gemini: { fast: "Flash 2.5", balanced: "Flash 2.5", reasoning: "Pro 2.5", codex: "Pro 2.5" },
}

const PROVIDER_LABELS: Record<AIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
}

function selectionValue(provider: AIProvider, model: ModelKey) {
  return `${provider}:${model}`
}

export function App() {
  const pathName = typeof window !== "undefined" ? window.location.pathname : "/"
  const isEditorPath = pathName === "/" || pathName === "/editor" || pathName === "/editor/"
  const isPuckPrototype = PUCK_ROUTE_PATHS.has(pathName) && isPuckRouteEnabled()
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

  // Follow system dark mode preference changes
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const handler = (e: MediaQueryListEvent) => setChatDarkMode(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])

  if (isPuckPrototype) {
    return (
      <Suspense fallback={<div style={{ height: "100vh", display: "grid", placeItems: "center" }}>Loading prototype…</div>}>
        <PuckChatPrototype />
      </Suspense>
    )
  }
  if (isSitesPage) return <SitesPage sites={sites} session={session} />
  if (!isEditorPath) return <SitesPage sites={sites} session={session} />

  return <EditorPage siteId={siteId} session={session} sites={sites} chatDarkMode={chatDarkMode} onSetChatDarkMode={setChatDarkMode} />
}

const PRESET_SITE_IDS = new Set(["avocado-hub", "avocado-stories", "avocado-magic", "avocado-odyssey"])

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
  const { t } = useT()
  const editorOrigin = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100"
  const { activeSiteConfig } = sites
  const activeSiteOrigin = useMemo(() => resolveSiteOrigin(activeSiteConfig), [activeSiteConfig])
  const componentManifest = useBlockManifest(activeSiteOrigin)

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
  const [agentApiKey, setAgentApiKey] = useState(() => {
    try { return localStorage.getItem("editor-agent-api-key") ?? "" } catch { return "" }
  })
  const [showNestedLabels, setShowNestedLabels] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showDebugDetails, setShowDebugDetails] = useState(() => resolveDefaultDebugMode())
  const [composerHeight, setComposerHeight] = useState(56)
  const [addBlockPicker, setAddBlockPicker] = useState<{ slug: string; afterBlockId?: string; beforeBlockId?: string } | null>(null)
  const [addBlockSearch, setAddBlockSearch] = useState("")
  const [isAddingBlock, setIsAddingBlock] = useState(false)
  const [copiedDebugEntryId, setCopiedDebugEntryId] = useState<string | null>(null)
  const [feedbackNoteEntryId, setFeedbackNoteEntryId] = useState<string | null>(null)
  const [feedbackNoteText, setFeedbackNoteText] = useState("")
  const [selectedVariationId, setSelectedVariationId] = useState<string | null>(null)
  const [imagePickerTarget, setImagePickerTarget] = useState<{ slug: string; blockId: string; editablePath: string; currentUrl?: string } | null>(null)
  const imagePickerOpen = imagePickerTarget !== null
  const [backendFeatures, setBackendFeatures] = useState<{ googleDrive?: boolean; unsplash?: boolean; imageGenerate?: boolean; imageGenerateChat?: boolean }>({})
  const [selectionModeEnabled, setSelectionModeEnabled] = useState(false)
  const [anchorRect, setAnchorRect] = useState<AnchorRect>(null)
  const [anchoredExpanded, setAnchoredExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<"chat" | "properties">("chat")
  const [siteConfigTab, setSiteConfigTab] = useState<"overview" | "tone" | "constraints" | "templates">("overview")
  const [configModalTab, setConfigModalTab] = useState<"general" | "brief" | "deploy">("general")
  const [driveValidation, setDriveValidation] = useState<{ status: "loading" | "ok" | "error"; message?: string } | null>(null)
  useEffect(() => { if (!sites.configSiteId) { setDriveValidation(null); setSiteConfigTab("overview") } }, [sites.configSiteId])

  const [showSiteSwitcher, setShowSiteSwitcher] = useState(false)
  const siteSwitcherRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!showSiteSwitcher) return
    const onClickOutside = (e: MouseEvent) => {
      if (siteSwitcherRef.current && !siteSwitcherRef.current.contains(e.target as Node)) setShowSiteSwitcher(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowSiteSwitcher(false) }
    document.addEventListener("mousedown", onClickOutside)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onClickOutside); document.removeEventListener("keydown", onKey) }
  }, [showSiteSwitcher])

  // Check which sites are reachable when the dropdown opens
  const [reachableSiteIds, setReachableSiteIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!showSiteSwitcher) { setReachableSiteIds(null); return }
    let active = true
    const check = async () => {
      const results = await Promise.all(
        sites.siteList.map(async (site) => {
          const origin = resolveSiteOrigin(site)
          try {
            const res = await fetch(`${origin}/api/editor/blocks?siteId=${encodeURIComponent(site.id)}`, { signal: AbortSignal.timeout(2500) })
            return res.ok ? site.id : null
          } catch { return null }
        })
      )
      if (active) setReachableSiteIds(new Set(results.filter(Boolean) as string[]))
    }
    void check()
    return () => { active = false }
  }, [showSiteSwitcher, sites.siteList])
  const dropdownSites = reachableSiteIds
    ? sites.siteList.filter(site => site.id === siteId || reachableSiteIds.has(site.id))
    : sites.siteList

  const chatPanelRef = useRef<HTMLElement>(null)
  const chatThreadRef = useRef<HTMLDivElement>(null)
  const shouldAutoScrollThreadRef = useRef(true)
  const didInitialThreadScrollRef = useRef(false)
  const splitHandleRef = useRef<HTMLDivElement>(null)
  const activeBlockIdRef = useRef<string | undefined>(undefined)
  const activeBlockTypeRef = useRef<string | undefined>(undefined)
  const activeEditablePathRef = useRef<string | undefined>(undefined)
  const onAppliedRef = useRef<(() => void) | undefined>(undefined)
  const draftPrimedRef = useRef(false)
  const draftPrimedOriginRef = useRef<string | null>(null)
  const slugSyncedFromPreviewRef = useRef(false)
  const lastStructuralNoticeAtRef = useRef(0)
  const resizeStartRef = useRef<{ y: number; composerHeight: number } | null>(null)
  const panelResizeRef = useRef<{ x: number; width: number } | null>(null)
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const anchoredComposerRef = useRef<HTMLDivElement>(null)
  const shimmerTargetRef = useRef<{ blockId: string; editablePath: string } | null>(null)
  const shimmerActiveRef = useRef(false)

  const routeOptions = useMemo(() => {
    const raw = Array.from(new Set([...availableSlugs, slug].filter(Boolean)))
    return raw.includes("/") ? ["/", ...raw.filter((route) => route !== "/")] : raw
  }, [availableSlugs, slug])

  const blockTypeOptions = useMemo(() => {
    if (!componentManifest.allowStructuralEdits) return []
    if (componentManifest.blocks.length > 0) {
      return componentManifest.blocks
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
  }, [componentManifest.allowStructuralEdits, componentManifest.blocks])

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
      summary: t("streamError.structuralDisabled"),
      changes: manifestUnavailableChanges(componentManifest.reason)
    })
  }

  const setSlugFromPreview = useCallback((nextSlug: string) => {
    setSlug((prev) => {
      if (prev === nextSlug) return prev
      slugSyncedFromPreviewRef.current = true
      return nextSlug
    })
  }, [])

  const previewCallbacks = useMemo<PreviewBridgeCallbacks>(() => ({
    onBlockClicked: (newSlug, blockId, blockType, editablePath, editableValue, rect) => {
      setSlugFromPreview(newSlug)
      activeBlockIdRef.current = blockId
      activeBlockTypeRef.current = blockType
      activeEditablePathRef.current = editablePath
      setActiveBlockId(blockId)
      setActiveBlockType(blockType)
      setActiveEditablePath(editablePath)
      setAnchorRect(blockId ? rect : null)
      if (blockId) preview.postToSite("highlightBlock", { blockId, editablePath: editablePath ?? null })
    },
    onRouteChanged: (newSlug) => {
      setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      setAnchorRect(null)
    },
    onBlockReordered: (newSlug, blockId, afterBlockId) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.reorderBlock(newSlug, blockId, afterBlockId)
    },
    onBlockDeleteRequested: (newSlug, blockId) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.deleteBlock(newSlug, blockId)
    },
    onBlockAddRequested: (newSlug, args) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      if (!args.afterBlockId && !args.beforeBlockId) return
      setAddBlockPicker({ slug: newSlug, afterBlockId: args.afterBlockId, beforeBlockId: args.beforeBlockId })
    },
    onListItemAddRequested: (newSlug, blockId, blockType, listKey, afterIndex) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.addListItem(newSlug, blockId, blockType, listKey, afterIndex)
    },
    onListItemRemoveRequested: (newSlug, blockId, blockType, listKey, index) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.removeListItem(newSlug, blockId, blockType, listKey, index)
    },
    onListItemMoveRequested: (newSlug, blockId, blockType, listKey, index, afterIndex) => {
      if (!componentManifest.allowStructuralEdits) {
        notifyStructuralUnavailable()
        return
      }
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void chatEngine.moveListItem(newSlug, blockId, blockType, listKey, index, afterIndex)
    },
    onOpenImagePicker: (newSlug, blockId, editablePath, currentUrl) => {
      setImagePickerTarget({ slug: newSlug, blockId, editablePath, currentUrl })
    },
    onEditBlockRequested: (_slug, _blockId) => {
      setAnchoredExpanded(true)
    },
    onInlineTextCommitted: (newSlug, blockId, editablePath, value) => {
      if (newSlug !== slug) setSlugFromPreview(newSlug)
      if (editablePath) {
        activeEditablePathRef.current = editablePath
        setActiveEditablePath(editablePath)
      }
      void chatEngine.inlineEditCommit(newSlug, blockId, editablePath, value)
    },
    onIframeScrolled: () => {
      setAnchorRect(null)
    }
  }), [componentManifest.allowStructuralEdits, setSlugFromPreview, slug])

  const preview = usePreviewBridge(slug, previewCallbacks, activeSiteOrigin)
  const previewPostToSiteRef = useRef(preview.postToSite)

  useEffect(() => {
    previewPostToSiteRef.current = preview.postToSite
  }, [preview.postToSite])

  const toggleSelectionMode = useCallback((force?: boolean) => {
    const next = force ?? !selectionModeEnabled
    setSelectionModeEnabled(next)
    preview.postToSite("setSelectionMode", { enabled: next })
    if (!next) {
      setActiveBlockId(undefined)
      setActiveBlockType(undefined)
      setActiveEditablePath(undefined)
      activeBlockIdRef.current = undefined
      activeEditablePathRef.current = undefined
      setAnchorRect(null)
    }
  }, [selectionModeEnabled, preview])

  // Esc exits selection mode without clearing existing block selection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectionModeEnabled) {
        toggleSelectionMode(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectionModeEnabled, toggleSelectionMode])

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
    getBlockDefaultProps: (blockType) => componentManifest.byType.get(blockType)?.defaultProps ?? null,
    onApplied: () => { onAppliedRef.current?.() },
    agentApiKey: agentApiKey || undefined
  })

  // Non-preset (migrated) sites: default to fast model and start with clean chat
  useEffect(() => {
    if (!PRESET_SITE_IDS.has(siteId)) {
      setModelKey("fast")
      chatEngine.clearChat()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount per siteId
  }, [siteId])

  const publish = usePublish(session, siteId, chatEngine.isLoading, chatEngine.pushAssistantFromResult, activeSiteOrigin, () => {
    preview.postToSite("draftUpdated", { focusBlockId: null })
  })

  const media = useMediaInput()

  const propsEnabled = activeTab === "properties" && chatEngine.hasBootstrapped
  const blockProps = useBlockProps(session, siteId, slug, activeBlockId, propsEnabled)
  const pageMeta = usePageMeta(session, siteId, slug, propsEnabled)
  onAppliedRef.current = () => {
    void blockProps.refetch()
    void pageMeta.refetch()
  }

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

  // Preview src: bootstrap draft mode via /api/draft once per origin,
  // then switch routes directly to avoid extra redirect navigations.
  const [previewSrc, setPreviewSrc] = useState(() =>
    buildSiteDraftEnableUrl("/", { session, siteId, editorOrigin }, activeSiteOrigin)
  )

  useEffect(() => {
    if (draftPrimedOriginRef.current !== activeSiteOrigin) {
      draftPrimedOriginRef.current = activeSiteOrigin
      draftPrimedRef.current = false
    }

    const params = { session, siteId, editorOrigin }

    // When the site navigated on its own (user clicked a link inside the iframe),
    // don't reload the iframe — the site already handled the navigation.
    if (slugSyncedFromPreviewRef.current) {
      slugSyncedFromPreviewRef.current = false
      return
    }

    if (siteDraftSecret && draftPrimedRef.current) {
      preview.postToSite("navigate", { href: buildSitePathWithQuery(slug, params) })
      return
    }

    const nextSrc = buildSiteDraftEnableUrl(slug, params, activeSiteOrigin)
    setPreviewSrc((prev) => (prev === nextSrc ? prev : nextSrc))
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
          const data = (await res.json()) as { plannerSource?: PlannerSource; availableProviders?: AIProvider[]; features?: { googleDrive?: boolean; unsplash?: boolean; imageGenerate?: boolean; imageGenerateChat?: boolean } }
          if (!active) return
          if (data.features) {
            setBackendFeatures((prev) => {
              if (prev.googleDrive === data.features!.googleDrive &&
                  prev.unsplash === data.features!.unsplash &&
                  prev.imageGenerate === data.features!.imageGenerate &&
                  prev.imageGenerateChat === data.features!.imageGenerateChat) return prev
              return data.features!
            })
          }
          if (Array.isArray(data.availableProviders) && data.availableProviders.length > 0) {
            setAvailableProviders(data.availableProviders)
            if (!data.availableProviders.includes(provider)) setProvider(data.availableProviders[0])
          }
          if (data.plannerSource === "openai" || data.plannerSource === "anthropic" || data.plannerSource === "gemini" || data.plannerSource === "demo") {
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

  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    const thread = chatThreadRef.current
    if (!thread) return
    const onScroll = () => {
      const atBottom = Math.abs(thread.scrollHeight - thread.scrollTop - thread.clientHeight) < 2 || thread.scrollHeight <= thread.clientHeight
      // Only disable auto-scroll when user manually scrolls UP — not on programmatic
      // scrolls that haven't caught up with new content yet
      if (!atBottom && thread.scrollTop < lastScrollTopRef.current) {
        shouldAutoScrollThreadRef.current = false
      } else if (atBottom) {
        shouldAutoScrollThreadRef.current = true
      }
      lastScrollTopRef.current = thread.scrollTop
    }
    thread.addEventListener("scroll", onScroll, { passive: true })
    return () => {
      thread.removeEventListener("scroll", onScroll)
    }
  }, [])

  // Scroll chat to latest on open/new stream updates (while user is near bottom).
  useEffect(() => {
    if (activeTab !== "chat") return
    const thread = chatThreadRef.current
    if (!thread) return
    const hasThreadContent = chatEngine.chatLog.length > 0 || Boolean(chatEngine.streamStatus) || Boolean(chatEngine.streamingText)
    if (!hasThreadContent) return

    const isInitialRender = !didInitialThreadScrollRef.current
    const hasUserEntryInLog = chatEngine.chatLog.some((entry) => entry.role === "user")
    if (isInitialRender && !hasUserEntryInLog && !chatEngine.streamStatus && !chatEngine.streamingText) {
      didInitialThreadScrollRef.current = true
      shouldAutoScrollThreadRef.current = false
      return
    }

    const shouldForceInitial = isInitialRender
    if (!shouldForceInitial && !shouldAutoScrollThreadRef.current) return

    const raf = window.requestAnimationFrame(() => {
      thread.scrollTop = thread.scrollHeight
      shouldAutoScrollThreadRef.current = true // re-arm after programmatic scroll
      didInitialThreadScrollRef.current = true
    })
    return () => window.cancelAnimationFrame(raf)
  }, [
    activeTab,
    chatEngine.chatLog.length,
    chatEngine.streamStatus,
    chatEngine.streamingText,
    chatEngine.streamSteps.length,
    chatEngine.streamingChanges.length
  ])

  // Nested labels sync
  useEffect(() => {
    preview.postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
  }, [showNestedLabels])

  // Keep iframe shimmer aligned to the actual component being processed.
  // Activates immediately when loading starts (using active block as fallback),
  // then re-targets when the stream identifies the actual focus block.
  useEffect(() => {
    const postToSite = previewPostToSiteRef.current
    if (!chatEngine.isLoading) {
      if (shimmerActiveRef.current) {
        postToSite("aiFieldLoading", { blockId: "", active: false })
      }
      shimmerTargetRef.current = null
      shimmerActiveRef.current = false
      return
    }

    const blockId = chatEngine.latestStreamFocusBlockId ?? activeBlockIdRef.current ?? activeBlockId ?? ""
    const activeTargetBlockId = activeBlockIdRef.current ?? activeBlockId ?? ""
    const editablePath = blockId && blockId === activeTargetBlockId ? (activeEditablePathRef.current ?? activeEditablePath ?? "") : ""
    postToSite("aiFieldLoading", { blockId, editablePath, active: true })
    shimmerTargetRef.current = { blockId, editablePath }
    shimmerActiveRef.current = true
  }, [chatEngine.isLoading, chatEngine.latestStreamFocusBlockId, activeBlockId, activeEditablePath])

  // Keep shimmer alive across async preview re-renders/remounts while loading.
  useEffect(() => {
    if (!chatEngine.isLoading) return
    const timer = window.setInterval(() => {
      const target = shimmerTargetRef.current
      if (!target) return
      previewPostToSiteRef.current("aiFieldLoading", {
        blockId: target.blockId,
        editablePath: target.editablePath,
        active: true
      })
    }, 1200)
    return () => window.clearInterval(timer)
  }, [chatEngine.isLoading])

  // Re-sync selection mode after route changes (preview bridge re-mounts and loses the attribute)
  useEffect(() => {
    if (selectionModeEnabled) {
      preview.postToSite("setSelectionMode", { enabled: true })
    }
  }, [slug])

  // Highlight active block sync
  useEffect(() => {
    if (!activeBlockId) return
    preview.postToSite("highlightBlock", { blockId: activeBlockId, editablePath: activeEditablePath ?? null })
  }, [activeBlockId, activeEditablePath])

  // Update Properties tab when a block is selected (only if already on properties tab),
  // and clear any field-AI context entries from a previous block
  // NOTE: auto-switch to properties tab on selection is temporarily disabled
  useEffect(() => {
    // if (activeBlockId && !message.trim()) setActiveTab("properties")
    chatEngine.clearFieldAiContext()
  }, [activeBlockId])

  // Clear anchor when activeBlockId is cleared
  useEffect(() => {
    if (!activeBlockId) setAnchorRect(null)
  }, [activeBlockId])

  // Reset expanded state when anchor target changes
  useEffect(() => {
    setAnchoredExpanded(false)
  }, [anchorRect])

  // Clear anchor on window resize
  useEffect(() => {
    const onResize = () => setAnchorRect(null)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // Compute anchored composer position
  const anchoredComposerEnabled = resolveAnchoredComposerEnabled()
  const anchoredPosition = useMemo(() => {
    if (!anchoredComposerEnabled) return null
    if (!anchorRect || !selectionModeEnabled || !activeBlockId) return null
    if (typeof window === "undefined" || window.innerWidth <= 1040) return null

    const iframeEl = preview.iframeRef.current
    if (!iframeEl) return null
    const iframeRect = iframeEl.getBoundingClientRect()

    const COMPOSER_WIDTH = 380
    const ICON_SIZE = 36
    const BLOCK_ACTION_SIZE = 26
    const CORNER_INSET = 8

    const elementTop = iframeRect.top + anchorRect.top
    const elementBottom = elementTop + anchorRect.height

    // Check if element is offscreen in iframe
    if (elementBottom < iframeRect.top || elementTop > iframeRect.bottom) return null

    // Top-right corner, aligned with the block action row.
    const top = elementTop + CORNER_INSET - (ICON_SIZE - BLOCK_ACTION_SIZE) / 2
    let left = iframeRect.left + anchorRect.left + anchorRect.width - ICON_SIZE - CORNER_INSET
    left = Math.max(iframeRect.left + CORNER_INSET, Math.min(left, iframeRect.right - ICON_SIZE - CORNER_INSET))

    return { top, left, width: COMPOSER_WIDTH }
  }, [anchorRect, selectionModeEnabled, activeBlockId, preview.iframeRef])

  // Auto-focus anchored composer textarea when expanded
  useEffect(() => {
    if (anchoredPosition && anchoredExpanded) {
      requestAnimationFrame(() => {
        anchoredComposerRef.current?.querySelector("textarea")?.focus()
      })
    }
  }, [!!anchoredPosition, anchoredExpanded])

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

  const handlePageAiAssist = useCallback((fieldLabel: string, fieldKind: string, currentValue: string) => {
    setActiveTab("chat")

    const suggestions = fieldAiSuggestions(fieldKind, fieldLabel, "Page", currentValue)
    const entry: ChatEntry = {
      id: `field-ai-${Date.now()}`,
      role: "assistant",
      text: `Editing: Page → ${fieldLabel}`,
      fieldAiContext: { blockId: "__page__", blockType: "__page__", fieldPath: fieldLabel, fieldLabel, blockDisplayName: "Page" },
      suggestions
    }

    chatEngine.setFieldAiContext(entry)
  }, [])

  const handleFieldAiQuickAction = useCallback((fieldPath: string, fieldLabel: string, fieldKind: string, currentValue: string, actionText: string) => {
    if (!activeBlockId || !activeBlockType) return
    const allMeta = getAllBlockMeta()
    const blockDisplayName = allMeta[activeBlockType]?.displayName ?? activeBlockType

    setActiveEditablePath(fieldPath)
    preview.postToSite("aiFieldLoading", { blockId: activeBlockId, editablePath: fieldPath, active: true })
    shimmerTargetRef.current = { blockId: activeBlockId, editablePath: fieldPath }
    shimmerActiveRef.current = true

    const entry: ChatEntry = {
      id: `field-ai-${Date.now()}`,
      role: "assistant",
      text: `Editing: ${blockDisplayName} → ${fieldLabel}`,
      fieldAiContext: { blockId: activeBlockId, blockType: activeBlockType, fieldPath, fieldLabel, blockDisplayName }
    }
    chatEngine.setFieldAiContext(entry)
    void chatEngine.submitChat(actionText)
  }, [activeBlockId, activeBlockType])

  const handlePageAiQuickAction = useCallback((fieldLabel: string, fieldKind: string, currentValue: string, actionText: string) => {
    setActiveEditablePath(fieldLabel)

    const entry: ChatEntry = {
      id: `field-ai-${Date.now()}`,
      role: "assistant",
      text: `Editing: Page → ${fieldLabel}`,
      fieldAiContext: { blockId: "__page__", blockType: "__page__", fieldPath: fieldLabel, fieldLabel, blockDisplayName: "Page" }
    }
    chatEngine.setFieldAiContext(entry)
    void chatEngine.submitChat(actionText)
  }, [])

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
    const clampChatWidth = (w: number) => Math.max(340, Math.min(w, window.innerWidth * 0.5))
    const onPointerMove = (event: PointerEvent) => {
      const composerStarted = resizeStartRef.current
      if (composerStarted) {
        const deltaY = event.clientY - composerStarted.y
        const next = clampComposerHeight(composerStarted.composerHeight - deltaY)
        setComposerHeight(next)
      }
      const panelStarted = panelResizeRef.current
      if (panelStarted) {
        const deltaX = event.clientX - panelStarted.x
        setChatWidth(clampChatWidth(panelStarted.width - deltaX))
      }
    }
    const onPointerUp = () => {
      const wasPanelDrag = !!panelResizeRef.current
      resizeStartRef.current = null
      panelResizeRef.current = null
      document.body.style.userSelect = ""
      if (wasPanelDrag) document.body.classList.remove("panel-resizing")
    }
    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerup", onPointerUp)
    return () => {
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      document.body.style.userSelect = ""
      document.body.classList.remove("panel-resizing")
    }
  }, [])

  useEffect(() => {
    const onWindowResize = () => {
      setComposerHeight((prev) => clampComposerHeight(prev))
      setChatWidth((prev) => prev ? Math.max(340, Math.min(prev, window.innerWidth * 0.5)) : prev)
    }
    window.addEventListener("resize", onWindowResize)
    return () => window.removeEventListener("resize", onWindowResize)
  }, [])

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
  const streamLabel = chatEngine.imageProgress ? chatEngine.imageProgress.stage : (chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? t("stream.shapingUpdate") : t("stream.gettingReady")))
  const streamTextLabel = chatEngine.imageProgress ? chatEngine.imageProgress.stage : (chatEngine.streamStatus ?? (chatEngine.streamTokenCount > 0 ? t("stream.updating") : t("stream.thinking")))
  const reconnectMatch = chatEngine.streamStatus?.match(/reconnecting(?:\s+agent\s+stream)?(?:\s+\((\d+)\/(\d+)\))?/i) ?? null
  const reconnectAttempt = reconnectMatch?.[1] ? Number(reconnectMatch[1]) : null
  const reconnectTotal = reconnectMatch?.[2] ? Number(reconnectMatch[2]) : null
  const reconnectBadgeLabel = reconnectMatch
    ? (reconnectAttempt && reconnectTotal ? `Reconnect ${reconnectAttempt}/${reconnectTotal}` : "Reconnecting")
    : null
  const fieldDraftDebugLabel = `field_draft ${chatEngine.fieldDraftDebug.eventsPerSecond}/s · chars ${chatEngine.fieldDraftDebug.charsPerSecond}/s · lag ${chatEngine.fieldDraftDebug.typingLagChars}`
  const chatPanelStyle = { "--composer-height": `${composerHeight}px` } as CSSProperties
  const chatPanelClassName = `chat-panel ${activeTab === "properties" ? "chat-panel--properties" : "chat-panel--chat"}`
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
      if (entry.debug.reason && entry.debug.reason !== entry.debug.reasonCategory) lines.push(`reasonDetail: ${entry.debug.reason}`)
      if (entry.debug.intent) lines.push(`intent: ${entry.debug.intent}`)
      if (entry.debug.plannerTier) lines.push(`plannerTier: ${entry.debug.plannerTier}`)
      if (entry.debug.modelUsed) lines.push(`model: ${entry.debug.modelUsed}${entry.debug.plannerSource ? ` (${entry.debug.plannerSource})` : ""}`)
      if (typeof entry.debug.planningAttempts === "number" && entry.debug.planningAttempts > 1) lines.push(`planningAttempts: ${entry.debug.planningAttempts}`)
      if (typeof entry.debug.opCount === "number") lines.push(`opCount: ${entry.debug.opCount}`)
      if (Array.isArray(entry.debug.skippedOps) && entry.debug.skippedOps.length > 0) {
        const details = entry.debug.skippedOps.map((s) => `[${s.index}] ${s.op} ${s.pageSlug ?? ""}${s.blockId ? "#" + s.blockId : ""}: ${s.reason}`).join(", ")
        lines.push(`skippedOps: ${details}`)
      } else if (typeof entry.debug.skippedOpCount === "number" && entry.debug.skippedOpCount > 0) {
        lines.push(`skippedOps: ${entry.debug.skippedOpCount}`)
      }
      if (Array.isArray(entry.debug.opTypes) && entry.debug.opTypes.length > 0) lines.push(`ops: ${entry.debug.opTypes.join(", ")}`)
      if (typeof entry.debug.totalTokens === "number") {
        lines.push(`tokens: in:${entry.debug.inputTokens ?? "?"} out:${entry.debug.outputTokens ?? "?"} total:${entry.debug.totalTokens}`)
      }
      if (typeof entry.debug.estimatedUsd === "number") lines.push(`cost: $${entry.debug.estimatedUsd.toFixed(4)}`)
      if (Array.isArray(entry.debug.timeline) && entry.debug.timeline.length > 0) {
        const compact = entry.debug.timeline.map((item) => `${item.stage}:${item.atMs}ms`).join(" -> ")
        lines.push(`timeline: ${compact}`)
      }
      if (entry.debug.promptExcerpt) lines.push(`prompt: ${entry.debug.promptExcerpt}`)
      // Context fields
      const contextParts: string[] = []
      if (entry.debug.currentPage) contextParts.push(`page: ${entry.debug.currentPage}`)
      if (entry.debug.siteId) contextParts.push(`site: ${entry.debug.siteId}`)
      if (entry.debug.activeBlockId) contextParts.push(`block: ${entry.debug.activeBlockId}`)
      if (entry.debug.activeEditablePath) contextParts.push(`path: ${entry.debug.activeEditablePath}`)
      if (contextParts.length > 0) lines.push(`context: ${contextParts.join(", ")}`)
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

  const buildDebugSummary = useCallback((entry: (typeof chatEngine.chatLog)[number]) => {
    if (!entry.debug) return t("chat.expandDetails")
    const parts: string[] = []
    if (entry.debug.outcome) parts.push(entry.debug.outcome.replace(/_/g, " "))
    if (typeof entry.debug.opCount === "number") {
      const count = entry.debug.opCount
      parts.push(`${count} op${count === 1 ? "" : "s"}`)
    }
    if (entry.debug.intent) parts.push(`intent: ${entry.debug.intent.replace(/_/g, " ")}`)
    if (entry.debug.plannerTier) parts.push(entry.debug.plannerTier.replace(/_/g, " "))
    if (Array.isArray(entry.debug.timeline) && entry.debug.timeline.length > 0) {
      const totalMs = entry.debug.timeline[entry.debug.timeline.length - 1]?.atMs
      if (typeof totalMs === "number") parts.push(`${totalMs}ms`)
    }
    return parts.join(" · ") || t("chat.expandDetails")
  }, [t])

  return (
    <div className="layout" style={chatWidth ? { "--chat-width": `${chatWidth}px` } as React.CSSProperties : undefined}>
      <aside className={chatPanelClassName} ref={chatPanelRef} style={chatPanelStyle}>
        <header className="chat-header">
          <div className="chat-header-top">
            <div className="chat-header-site-name" ref={siteSwitcherRef}>
              {sites.siteList.length > 1 ? (
                <button
                  type="button"
                  className="site-switcher-trigger"
                  onClick={() => setShowSiteSwitcher((v) => !v)}
                  aria-expanded={showSiteSwitcher}
                  aria-haspopup="menu"
                >
                  <span className="site-switcher-trigger-label">{activeSiteConfig.name}</span>
                  <ChevronDown size={12} className={`site-switcher-chevron${showSiteSwitcher ? " is-open" : ""}`} aria-hidden="true" />
                </button>
              ) : (
                <span className="site-switcher-trigger-label">{activeSiteConfig.name}</span>
              )}
              <button
                type="button"
                className="chat-header-icon-btn"
                aria-label={t("header.siteSettings")}
                title={t("header.siteSettings")}
                onClick={() => sites.setConfigSiteId(siteId)}
              >
                <Settings size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="chat-header-icon-btn"
                aria-label={t("header.syncFromSite")}
                title={t("header.syncFromSiteTitle")}
                disabled={chatEngine.isLoading}
                onClick={async () => {
                  const count = await chatEngine.syncFromSite()
                  if (count > 0) {
                    chatEngine.pushAssistantFromResult({
                      status: "applied",
                      summary: count === 1 ? t("header.syncedPage") : t("header.syncedPages", { count }),
                      changes: []
                    })
                  }
                }}
              >
                <RefreshCw size={14} aria-hidden="true" />
              </button>
              {showSiteSwitcher && (
                <div className="site-switcher-dropdown" role="menu" aria-label={t("header.allSites")}>
                  <div className="site-switcher-list">
                    {dropdownSites.map((site) => (
                      <button
                        key={site.id}
                        type="button"
                        role="menuitem"
                        className={`site-switcher-item${site.id === siteId ? " is-active" : ""}`}
                        onClick={() => {
                          if (site.id !== siteId) sites.openEditorForSite(site.id)
                          setShowSiteSwitcher(false)
                        }}
                      >
                        <span className="site-switcher-item-dot" />
                        <span className="site-switcher-item-name">{site.name}</span>
                        {site.id === siteId && <Check size={12} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                  <a href="/sites" className="site-switcher-footer" onClick={() => setShowSiteSwitcher(false)}>
                    {t("header.viewAllSites")}
                  </a>
                </div>
              )}
            </div>
            <div className="chat-header-right">
              {componentManifest.status === "degraded" ? (
                <span className="planner-badge" title={componentManifest.reason ?? "Components unavailable"}>
                  {t("header.limited")}
                </span>
              ) : null}
              {chatEngine.plannerBadgeState === "demo" ? (
                <span className="planner-badge planner-badge-demo">{t("header.demoMode")}</span>
              ) : null}
              <button
                type="button"
                className="chat-header-icon-btn"
                aria-label={t("header.moreOptions")}
                onClick={() => setShowSettingsModal(true)}
              >
                <Ellipsis size={14} aria-hidden="true" />
              </button>
              <button type="button" className="publish-preview-btn" onClick={() => void publish.publishSite()} disabled={chatEngine.isLoading || publish.isPublishing}>
                {publish.publishInProgress ? <span className="publish-spinner" aria-hidden="true" /> : null}
                {publish.publishInProgress ? t("header.publishing") : t("header.publish")}
              </button>
              {publish.publishStatus ? (
                <>
                  {publish.publishStatus.inspectUrl ? (
                    <a className="publish-view-link" href={publish.publishStatus.inspectUrl} target="_blank" rel="noreferrer">
                      {t("header.viewDeploy")}
                    </a>
                  ) : null}
                  {liveSiteUrl ? (
                    <a
                      className="live-site-icon-btn"
                      href={liveSiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={t("header.openLiveSite")}
                      title={t("header.openLiveSite")}
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                    </a>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
          <label className="chat-header-slug">
            <select value={slug} onChange={(e) => setSlug(e.target.value || "/")} disabled={isLoadingSlugs}>
              {routeOptions.map((route) => (
                <option key={route} value={route}>
                  {slugLabel(route)}
                </option>
              ))}
            </select>
          </label>
        </header>

        <ChatThreadCore
          ref={chatThreadRef}
          className="chat-thread"
          style={{ display: activeTab === "chat" ? "" : "none" }}
          entries={chatEngine.chatLog}
          isLoading={chatEngine.isLoading}
          streamStatus={chatEngine.streamStatus}
          streamStatusLabel={streamTextLabel}
          streamingText={chatEngine.streamingText}
          streamSteps={chatEngine.streamSteps}
          streamingChanges={chatEngine.streamingChanges}
          undoInFlightEntryId={chatEngine.undoInFlightEntryId}
          onSuggestionClick={(line) => void chatEngine.submitChat(line)}
          onUndo={(entryId) => void chatEngine.applyUndoHistory(entryId)}
          undoLabel={t("chat.undo")}
          undoneLabel={t("chat.undone")}
          renderEntryExtras={(entry) => (
            <>
              {entry.variations && entry.variations.options.length > 0 ? (
                <div className="msg-variations">
                  {entry.variations.options.map((option, idx) => (
                    <button
                      key={option.id ?? `${entry.id}-v-${idx}`}
                      type="button"
                      className="msg-variation-card"
                      disabled={chatEngine.isLoading}
                      onClick={async () => {
                        const v = entry.variations!
                        try {
                          const res = await fetch(`${orchestrator}/ops`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              session,
                              siteId,
                              ops: [{ op: "update_props", pageSlug: v.pageSlug, blockId: v.blockId, patch: option.patch }],
                            }),
                          })
                          if (res.ok) {
                            preview.postToSite("draftUpdated", { focusBlockId: v.blockId })
                            chatEngine.pushAssistantFromResult({
                              status: "applied",
                              summary: `Applied variation: ${option.title}`,
                              changes: [option.summary],
                            })
                          }
                        } catch {
                          // ignore
                        }
                      }}
                    >
                      <div className="msg-variation-preview-wrap">
                        <VariationScaledPreview
                          block={{ id: entry.variations!.blockId, type: entry.variations!.blockType, props: { ...entry.variations!.baseProps, ...option.patch } }}
                          virtualWidth={1280}
                        />
                      </div>
                      <div className="msg-variation-meta">
                        <span className="msg-variation-badge">{String.fromCharCode(65 + idx)}</span>
                        <div className="msg-variation-content">
                          <span className="msg-variation-title">{option.title}</span>
                          <span className="msg-variation-summary">{option.summary}</span>
                        </div>
                      </div>
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
                <div className="msg-debug-shell">
                  <details className="msg-debug-details">
                    <summary className="msg-debug-summary">
                      <span className="msg-debug-summary-left">
                        <span className="msg-debug-title">Debug</span>
                        <span className="msg-debug-summary-text">{buildDebugSummary(entry)}</span>
                      </span>
                      <span className="msg-debug-chevron" aria-hidden="true" />
                    </summary>
                    <div className="msg-debug">
                      <ul>
                        {entry.debug.traceId ? <li>traceId: {entry.debug.traceId}</li> : null}
                        {entry.debug.promptHash ? <li>promptHash: {entry.debug.promptHash}</li> : null}
                        {entry.debug.outcome ? <li>outcome: {entry.debug.outcome}</li> : null}
                        {entry.debug.reasonCategory ? <li>reason: {entry.debug.reasonCategory}</li> : null}
                        {entry.debug.reason && entry.debug.reason !== entry.debug.reasonCategory ? <li>reasonDetail: {entry.debug.reason}</li> : null}
                        {entry.debug.intent ? <li>intent: {entry.debug.intent}</li> : null}
                        {entry.debug.plannerTier ? <li>plannerTier: {entry.debug.plannerTier}</li> : null}
                        {entry.debug.modelUsed ? <li>model: {entry.debug.modelUsed}{entry.debug.plannerSource ? ` (${entry.debug.plannerSource})` : ""}</li> : null}
                        {typeof entry.debug.planningAttempts === "number" && entry.debug.planningAttempts > 1 ? <li>planningAttempts: {entry.debug.planningAttempts}</li> : null}
                        {typeof entry.debug.opCount === "number" ? <li>opCount: {entry.debug.opCount}</li> : null}
                        {Array.isArray(entry.debug.skippedOps) && entry.debug.skippedOps.length > 0 ? (
                          <li>skippedOps: {entry.debug.skippedOps.map((s) => `[${s.index}] ${s.op} ${s.pageSlug ?? ""}${s.blockId ? "#" + s.blockId : ""}: ${s.reason}`).join(", ")}</li>
                        ) : typeof entry.debug.skippedOpCount === "number" && entry.debug.skippedOpCount > 0 ? <li>skippedOps: {entry.debug.skippedOpCount}</li> : null}
                        {Array.isArray(entry.debug.opTypes) && entry.debug.opTypes.length > 0 ? <li>ops: {entry.debug.opTypes.join(", ")}</li> : null}
                        {typeof entry.debug.totalTokens === "number" ? <li>tokens: in:{entry.debug.inputTokens ?? "?"} out:{entry.debug.outputTokens ?? "?"} total:{entry.debug.totalTokens}</li> : null}
                        {typeof entry.debug.estimatedUsd === "number" ? <li>cost: ${entry.debug.estimatedUsd.toFixed(4)}</li> : null}
                        {Array.isArray(entry.debug.timeline) && entry.debug.timeline.length > 0 ? (
                          <li>timeline: {entry.debug.timeline.map((item) => `${item.stage}:${item.atMs}ms`).join(" -> ")}</li>
                        ) : null}
                        {entry.debug.promptExcerpt ? <li>prompt: {entry.debug.promptExcerpt}</li> : null}
                        {(entry.debug.currentPage || entry.debug.siteId || entry.debug.activeBlockId || entry.debug.activeEditablePath) ? (
                          <li>context: {[
                            entry.debug.currentPage ? `page: ${entry.debug.currentPage}` : null,
                            entry.debug.siteId ? `site: ${entry.debug.siteId}` : null,
                            entry.debug.activeBlockId ? `block: ${entry.debug.activeBlockId}` : null,
                            entry.debug.activeEditablePath ? `path: ${entry.debug.activeEditablePath}` : null
                          ].filter(Boolean).join(", ")}</li>
                        ) : null}
                      </ul>
                    </div>
                  </details>
                  <button
                    type="button"
                    className="msg-debug-copy-btn"
                    onClick={() => void copyAssistantBubble(entry)}
                    aria-label={copiedDebugEntryId === entry.id ? t("chat.copied") : t("chat.copyDebug")}
                    title={copiedDebugEntryId === entry.id ? t("chat.copied") : t("chat.copy")}
                  >
                    {copiedDebugEntryId === entry.id ? (
                      <Check aria-hidden="true" size={14} />
                    ) : (
                      <Copy aria-hidden="true" size={14} />
                    )}
                  </button>
                </div>
              ) : null}
              {entry.role === "assistant" && entry.debug?.traceId && entry.id !== "welcome" ? (
                <div className="msg-feedback-row">
                  <button
                    type="button"
                    className={`msg-feedback-btn ${entry.feedback?.rating === "up" ? "msg-feedback-btn--active" : ""}`}
                    onClick={() => {
                      if (!entry.feedback) void chatEngine.submitFeedback(entry.id, "up")
                    }}
                    disabled={!!entry.feedback}
                    title={t("chat.goodResponse")}
                  >
                    <ThumbsUp aria-hidden="true" size={13} />
                  </button>
                  <button
                    type="button"
                    className={`msg-feedback-btn ${entry.feedback?.rating === "down" ? "msg-feedback-btn--active" : ""}`}
                    onClick={() => {
                      if (!entry.feedback) {
                        setFeedbackNoteEntryId(feedbackNoteEntryId === entry.id ? null : entry.id)
                        setFeedbackNoteText("")
                      }
                    }}
                    disabled={!!entry.feedback}
                    title={t("chat.badResponse")}
                  >
                    <ThumbsDown aria-hidden="true" size={13} />
                  </button>
                  {entry.feedback ? (
                    <span className="msg-feedback-label">
                      {entry.feedback.rating === "up" ? t("chat.feedbackThanks") : t("chat.feedbackNoted")}
                      {entry.feedback.note ? ` — "${entry.feedback.note}"` : ""}
                    </span>
                  ) : null}
                  {feedbackNoteEntryId === entry.id && !entry.feedback ? (
                    <form
                      className="msg-feedback-note-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void chatEngine.submitFeedback(entry.id, "down", feedbackNoteText || undefined)
                        setFeedbackNoteEntryId(null)
                        setFeedbackNoteText("")
                      }}
                    >
                      <input
                        className="msg-feedback-note-input"
                        placeholder={t("chat.feedbackPlaceholder")}
                        value={feedbackNoteText}
                        onChange={(e) => setFeedbackNoteText(e.target.value)}
                        autoFocus
                      />
                      <button type="submit" className="msg-feedback-note-submit">{t("chat.feedbackSend")}</button>
                    </form>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
          renderStreamingExtras={() => (
            <>
              {reconnectBadgeLabel ? (
                <span className="stream-reconnect-badge stream-reconnect-badge-inline" title={chatEngine.streamStatus ?? undefined}>
                  {reconnectBadgeLabel}
                </span>
              ) : null}
              {showDebugDetails && chatEngine.fieldDraftDebugEnabled ? (
                <div className="streaming-debug-inline">{fieldDraftDebugLabel}</div>
              ) : null}
            </>
          )}
          renderStreamStatusFallback={() => (
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
              {reconnectBadgeLabel ? (
                <span className="stream-reconnect-badge" title={chatEngine.streamStatus ?? undefined}>
                  {reconnectBadgeLabel}
                </span>
              ) : null}
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
              {showDebugDetails && chatEngine.fieldDraftDebugEnabled ? (
                <div className="streaming-debug-inline">{fieldDraftDebugLabel}</div>
              ) : null}
            </div>
          )}
        />

        <PropertyPanel
          style={{ display: activeTab === "properties" ? "" : "none" }}
          blockId={activeBlockId}
          blockType={activeBlockType}
          props={blockProps.props}
          status={blockProps.status}
          slug={slug}
          pageName={slugLabel(slug)}
          onDeselectBlock={() => { setActiveBlockId(undefined); setActiveBlockType(undefined) }}
          navLabel={sites.headerConfig.navLabels?.[slug] ?? ""}
          onNavLabelChange={(s, label) => {
            void sites.updateHeaderConfig({ navLabels: { [s]: label } })
            preview.postToSite("draftUpdated", {})
          }}
          pageMeta={pageMeta.meta}
          onPageMetaChange={(field, value) => {
            const nextMeta = { ...pageMeta.meta, [field]: value }
            pageMeta.setMeta(nextMeta)
            void (async () => {
              try {
                const res = await fetch(`${orchestrator}/ops`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    session,
                    siteId,
                    ops: [{ op: "update_page_meta", pageSlug: slug, patch: { [field]: value } }]
                  })
                })
                const data = (await res.json()) as { status?: string }
                if (!res.ok || data.status !== "applied") {
                  void pageMeta.refetch()
                  return
                }
                preview.postToSite("draftUpdated", {})
              } catch {
                void pageMeta.refetch()
              }
            })()
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
          onPageAiAssist={handlePageAiAssist}
          onAiQuickAction={handleFieldAiQuickAction}
          onPageAiQuickAction={handlePageAiQuickAction}
          aiLoading={chatEngine.isLoading}
          aiLoadingPath={activeEditablePath}
          highlightPath={activeEditablePath}
          onAddListItem={activeBlockId && activeBlockType ? (listKey) => {
            void chatEngine.addListItem(slug, activeBlockId, activeBlockType, listKey)
              .then(() => blockProps.refetch())
          } : undefined}
          manifestByType={componentManifest.byType}
          siteOrigin={activeSiteOrigin}
        />

        <div
          ref={splitHandleRef}
          className="composer-splitter"
          style={{ display: activeTab === "chat" ? "" : "none" }}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("resize.inputPanel")}
          onPointerDown={(event) => {
            resizeStartRef.current = { y: event.clientY, composerHeight }
            document.body.style.userSelect = "none"
          }}
        />

        <ChatComposerCore
          className="composer"
          style={{ display: activeTab === "chat" ? "" : "none" }}
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
          selectionModeEnabled={selectionModeEnabled}
          onToggleSelectionMode={() => toggleSelectionMode()}
        />

        <nav className="panel-tabs panel-tabs-main">
          <button
            type="button"
            className={`panel-tab panel-tab-main ${activeTab === "chat" ? "is-active" : ""}`}
            onClick={() => setActiveTab("chat")}
            aria-label={t("tabs.chat")}
            title={t("tabs.chat")}
          >
            <Bot size={22} />
          </button>
          <button
            type="button"
            className={`panel-tab panel-tab-main ${activeTab === "properties" ? "is-active" : ""}`}
            onClick={() => setActiveTab("properties")}
            aria-label={t("tabs.properties")}
            title={t("tabs.properties")}
          >
            <SlidersHorizontal size={22} />
            {activeBlockId ? <span className="panel-tab-dot" /> : null}
          </button>
        </nav>
      </aside>

      <div
        className="panel-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resize.chatPanel")}
        onPointerDown={(event) => {
          const panel = chatPanelRef.current
          if (!panel) return
          panelResizeRef.current = { x: event.clientX, width: panel.offsetWidth }
          document.body.style.userSelect = "none"
          document.body.classList.add("panel-resizing")
        }}
      />

      <div className="preview">
        <iframe
          ref={preview.iframeRef}
          title={t("preview.title")}
          src={previewSrc}
          onLoad={() => {
            if (siteDraftSecret && !draftPrimedRef.current) {
              draftPrimedRef.current = true
              draftPrimedOriginRef.current = activeSiteOrigin
            }
            preview.postToSite("setNestedLabelsVisibility", { visible: showNestedLabels })
          }}
        />
      </div>

      {anchoredPosition && anchoredExpanded ? (
        <div
          ref={anchoredComposerRef}
          className="composer--anchored is-expanded"
          style={{ top: anchoredPosition.top, left: anchoredPosition.left, width: anchoredPosition.width }}
        >
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
            onAutoHeightChange={() => {}}
            compact
          />
        </div>
      ) : null}

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
          <div className="variation-modal" role="dialog" aria-modal="true" aria-label={t("variation.title")} onClick={(e) => e.stopPropagation()}>
            <div className="variation-modal-header">
              <h2>Choose a Variation</h2>
              <button
                type="button"
                className="settings-close-btn"
                aria-label={t("variation.close")}
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
                {chatEngine.isApplyingVariation ? t("variation.applying") : t("variation.apply", { title: selectedOption?.title ?? "" })}
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
          <div className="add-block-modal" role="dialog" aria-modal="true" aria-label={t("addBlock.title")} onClick={(e) => e.stopPropagation()}>
            <div className="add-block-modal-header">
              <h2>Add block</h2>
              <p>
                {addBlockPicker.beforeBlockId && !addBlockPicker.afterBlockId
                  ? t("addBlock.insertAbove")
                  : t("addBlock.insertBelow")}
              </p>
              <button
                type="button"
                className="settings-close-btn"
                aria-label={t("addBlock.close")}
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
                  placeholder={t("addBlock.searchPlaceholder")}
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

      <SettingsModal
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
        useStreaming={useStreaming}
        onStreamingChange={setUseStreaming}
        showNestedLabels={showNestedLabels}
        onNestedLabelsChange={setShowNestedLabels}
        chatDarkMode={chatDarkMode}
        onDarkModeChange={onSetChatDarkMode}
        showDebugDetails={showDebugDetails}
        onDebugDetailsChange={setShowDebugDetails}
        fieldDraftDebugEnabled={chatEngine.fieldDraftDebugEnabled}
        onFieldDraftDebugChange={chatEngine.setFieldDraftDebugEnabled}
        provider={provider}
        modelKey={modelKey}
        availableProviders={availableProviders}
        onModelChange={(p, m) => { setProvider(p); setModelKey(m) }}
        onClearChat={chatEngine.clearChat}
        agentApiKey={agentApiKey}
        onAgentApiKeyChange={(key) => {
          setAgentApiKey(key)
          try { localStorage.setItem("editor-agent-api-key", key) } catch {}
        }}
      />

      <Sheet open={!!sites.configSite} onOpenChange={(open) => { if (!open) sites.setConfigSiteId(null) }}>
        <SheetContent side="right" className="w-full sm:max-w-lg gap-0 p-0 font-sans text-foreground text-sm">
          <SheetHeader className="px-5 pt-4 pb-3 border-b border-border">
            <SheetTitle className="text-base font-bold tracking-tight">Site Config</SheetTitle>
          </SheetHeader>
          {sites.configSite ? (
            <>
              <nav className="panel-tabs">
                <button type="button" className={`panel-tab ${configModalTab === "general" ? "is-active" : ""}`} onClick={() => setConfigModalTab("general")}>{t("sites.general")}</button>
                <button type="button" className={`panel-tab ${configModalTab === "brief" ? "is-active" : ""}`} onClick={() => setConfigModalTab("brief")}>{t("sites.brief")}</button>
                <button type="button" className={`panel-tab ${configModalTab === "deploy" ? "is-active" : ""}`} onClick={() => setConfigModalTab("deploy")}>{t("sites.deploy")}</button>
              </nav>
              <div className="sites-modal-body">
                {configModalTab === "general" ? (
                  <div className="sites-form-grid">
                    <label className="sites-form-field">
                      <span>{t("sites.siteName")}</span>
                      <input
                        type="text"
                        value={sites.configSite.name}
                        placeholder={t("sites.siteNamePlaceholder")}
                        onChange={(e) => sites.updateConfigSite({ name: e.target.value })}
                      />
                    </label>
                    <p className="sites-form-section-title">{t("sites.header")}</p>
                    <label className="sites-form-field">
                      <span>{t("sites.siteHeaderName")}</span>
                      <input
                        type="text"
                        value={sites.headerConfig.name ?? ""}
                        placeholder={t("sites.siteHeaderName")}
                        onBlur={(e) => {
                          void sites.updateHeaderConfig({ name: e.target.value })
                          preview.postToSite("draftUpdated", {})
                        }}
                        onChange={(e) => sites.updateHeaderConfig({ name: e.target.value })}
                      />
                    </label>
                    <label className="sites-form-field">
                      <span>{t("sites.logoUrl")}</span>
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
                      <div className="sites-ai-tabs" role="tablist" aria-label={t("sites.editorialBrief")}>
                        <button type="button" className={siteConfigTab === "overview" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("overview")}>{t("sites.overview")}</button>
                        <button type="button" className={siteConfigTab === "tone" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("tone")}>{t("sites.tone")}</button>
                        <button type="button" className={siteConfigTab === "constraints" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("constraints")}>{t("sites.constraints")}</button>
                        <button type="button" className={siteConfigTab === "templates" ? "sites-ai-tab active" : "sites-ai-tab"} onClick={() => setSiteConfigTab("templates")}>{t("sites.templates")}</button>
                      </div>
                      {siteConfigTab === "overview" ? (
                        <label className="sites-form-field">
                          <span>{t("sites.overview")}</span>
                          <textarea value={sites.configSite.purpose} placeholder={t("sites.overviewPlaceholder")} onChange={(e) => sites.updateConfigSite({ purpose: e.target.value })} rows={8} />
                        </label>
                      ) : null}
                      {siteConfigTab === "tone" ? (
                        <label className="sites-form-field">
                          <span>{t("sites.tone")}</span>
                          <textarea value={sites.configSite.tone ?? ""} placeholder={t("sites.tonePlaceholder")} onChange={(e) => sites.updateConfigSite({ tone: e.target.value })} rows={8} />
                        </label>
                      ) : null}
                      {siteConfigTab === "constraints" ? (
                        <label className="sites-form-field">
                          <span>{t("sites.constraints")}</span>
                          <textarea
                            value={(sites.configSite.constraints ?? []).join("\n")}
                            placeholder={t("sites.constraintsPlaceholder")}
                            onChange={(e) => sites.updateConfigSite({ constraints: e.target.value.split(/\n|,/g).map((s) => s.trim()).filter(Boolean) })}
                            rows={8}
                          />
                        </label>
                      ) : null}
                      {siteConfigTab === "templates" ? (
                        <div className="sites-form-field">
                          <span>{t("sites.pageTemplates")}</span>
                          <p className="sites-form-hint">{t("sites.pageTemplatesHint")}</p>
                          {(sites.configSite?.pageTemplates ?? []).map((tpl, idx) => (
                            <div key={idx} className="sites-template-entry">
                              <input
                                type="text"
                                value={tpl.name}
                                placeholder={t("sites.templateName")}
                                onChange={(e) => {
                                  const updated = [...(sites.configSite?.pageTemplates ?? [])]
                                  updated[idx] = { ...updated[idx], name: e.target.value }
                                  sites.updateConfigSite({ pageTemplates: updated })
                                }}
                              />
                              <textarea
                                value={tpl.description}
                                placeholder={t("sites.templateDescription")}
                                rows={3}
                                onChange={(e) => {
                                  const updated = [...(sites.configSite?.pageTemplates ?? [])]
                                  updated[idx] = { ...updated[idx], description: e.target.value }
                                  sites.updateConfigSite({ pageTemplates: updated })
                                }}
                              />
                              <button
                                type="button"
                                className="sites-template-remove"
                                onClick={() => {
                                  const updated = (sites.configSite?.pageTemplates ?? []).filter((_, i) => i !== idx)
                                  sites.updateConfigSite({ pageTemplates: updated.length > 0 ? updated : undefined })
                                }}
                              >{t("sites.removeTemplate")}</button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="sites-template-add"
                            onClick={() => sites.updateConfigSite({ pageTemplates: [...(sites.configSite?.pageTemplates ?? []), { name: "", description: "" }] })}
                          >{t("sites.addTemplate")}</button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {configModalTab === "deploy" ? (
                  <div className="sites-form-grid">
                    <div className="sites-settings-grid">
                      <label className="sites-form-field">
                        <span>{t("sites.hosting")}</span>
                        <input type="text" value={sites.configSite.hosting} placeholder={t("sites.hostingPlaceholder")} onChange={(e) => sites.updateConfigSite({ hosting: e.target.value })} />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelProjectId")}</span>
                        <input type="text" value={sites.configSite.vercelProjectId ?? ""} placeholder={t("sites.vercelProjectIdPlaceholder")} onChange={(e) => sites.updateConfigSite({ vercelProjectId: e.target.value })} />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelTeamId")}</span>
                        <input type="text" value={sites.configSite.vercelTeamId ?? ""} placeholder={t("sites.vercelTeamIdPlaceholder")} onChange={(e) => sites.updateConfigSite({ vercelTeamId: e.target.value })} />
                      </label>
                      <label className="sites-form-field">
                        <span>{t("sites.vercelProductionUrl")}</span>
                        <input type="url" value={sites.configSite.vercelProductionUrl ?? ""} placeholder={t("sites.vercelProductionUrlPlaceholder")} onChange={(e) => sites.updateConfigSite({ vercelProductionUrl: e.target.value })} />
                      </label>
                      <label className="sites-form-field sites-form-field-wide">
                        <span>{t("sites.vercelDeployHook")}</span>
                        <input type="url" value={sites.configSite.vercelDeployHookUrl ?? ""} placeholder={t("sites.vercelDeployHookPlaceholder")} onChange={(e) => sites.updateConfigSite({ vercelDeployHookUrl: e.target.value })} />
                      </label>
                      <label className="sites-form-field sites-form-field-wide">
                        <span>{t("sites.googleDriveFolderId")}</span>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input
                            type="text"
                            value={sites.configSite.gdriveFolderId ?? ""}
                            placeholder={t("sites.googleDrivePlaceholder")}
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
                                  setDriveValidation({ status: "ok", message: data.items.length > 0 ? t("sites.driveConnectedImages") : t("sites.driveConnectedEmpty") })
                                } else {
                                  const data = (await res.json().catch(() => ({}))) as { error?: string }
                                  setDriveValidation({ status: "error", message: data.error ?? `HTTP ${res.status}` })
                                }
                              } catch {
                                setDriveValidation({ status: "error", message: t("sites.driveError") })
                              }
                            }}
                          >
                            {driveValidation?.status === "loading" ? t("sites.testing") : t("sites.test")}
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
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <ImagePickerModal
        open={imagePickerOpen}
        features={{ ...backendFeatures, googleDrive: backendFeatures.googleDrive || Boolean(activeSiteConfig.gdriveFolderId?.trim()) }}
        currentUrl={imagePickerTarget?.currentUrl}
        gdriveFolderId={activeSiteConfig.gdriveFolderId}
        cmsMedia={activeSiteConfig.cmsMedia}
        siteOrigin={activeSiteOrigin}
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
                body: JSON.stringify(withIntegrationContext({ session, siteId, ops }, componentManifest.manifest))
              })
              const data = (await res.json()) as { status?: string; previewVersion?: number; error?: string; details?: unknown }
              if (res.ok && data.status === "applied") {
                preview.postToSite("draftUpdated", { focusBlockId: blockId })
                chatEngine.pushAssistantFromResult({ status: "applied", summary: t("ops.changedImage") }, { canUndo: true })
                void blockProps.refetch()
              } else {
                console.error("[ImagePicker] ops failed:", res.status, data.error, data.details ?? "", "ops:", JSON.stringify(ops))
              }
            } catch (err) { console.error("[ImagePicker] ops failed:", err) }
          })()
        }}
      />
    </div>
  )
}
