/**
 * Reactive UI store — Zustand with subscribeWithSelector + devtools.
 *
 * Drives all React re-renders via selectors.  Sub-hooks and async
 * functions read/write via `useEditorStore.getState()` (always-fresh,
 * no stale closures, no refs).
 *
 * Side effects (localStorage sync, DOM class toggling) are centralized
 * in the `subscribe` handler at the bottom — never scattered across
 * useEffect calls in components.
 */

import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"

import type {
  AIProvider,
  AssistantResponse,
  ChatEntry,
  ModelKey,
  PlannerBadgeState,
  VariationModalState,
} from "../lib/editor-types"
import type { AnchorRect } from "../hooks/usePreviewBridge"
import {
  CHAT_THEME_STORAGE_KEY,
  CHAT_WIDTH_STORAGE_KEY,
  DEBUG_MODE_STORAGE_KEY,
  MODEL_KEY_STORAGE_KEY,
  PROVIDER_STORAGE_KEY,
  createId,
  resolveDefaultChatDarkMode,
  resolveDefaultChatWidth,
  resolveDefaultDebugMode,
  resolveDefaultModelKey,
  resolveDefaultProvider,
  splitAiInsightChanges,
} from "../lib/defaults"

// ── Helpers ─────────────────────────────────────────────────────────

function normalizeValidationErrors(raw: AssistantResponse["validationErrors"]) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  const field = Object.values(raw.fieldErrors ?? {}).flat().map(String)
  const form = (raw.formErrors ?? []).map(String)
  return [...form, ...field]
}

// ── State shape ─────────────────────────────────────────────────────

export type EditorState = {
  // ── selection ───────────────────────────────────────────────────
  activeBlockId: string | undefined
  activeBlockType: string | undefined
  activeEditablePath: string | undefined

  // ── navigation ──────────────────────────────────────────────────
  slug: string
  availableSlugs: string[]
  isLoadingSlugs: boolean

  // ── chat ────────────────────────────────────────────────────────
  chatLog: ChatEntry[]
  isLoading: boolean
  streamStatus: string | null
  streamingText: string | null
  streamingChanges: string[]
  streamSteps: { label: string; done: boolean }[]
  opChecklist: { label: string; done: boolean }[]
  streamTokenCount: number
  latestStreamFocusBlockId: string | null
  imageProgress: { percent: number; stage: string } | null
  continuationChainId: string | null

  // ── plan ────────────────────────────────────────────────────────
  pendingPlanId: string | null
  plannerBadgeState: PlannerBadgeState

  // ── variation ───────────────────────────────────────────────────
  variationModal: VariationModalState | null
  isApplyingVariation: boolean

  // ── ui ──────────────────────────────────────────────────────────
  composerHeight: number
  chatWidth: number | null
  activeTab: "chat" | "properties" | "history"
  showSettingsModal: boolean
  showDebugDetails: boolean
  addBlockPicker: { slug: string; afterBlockId?: string; beforeBlockId?: string } | null
  addBlockSearch: string
  isAddingBlock: boolean
  imagePickerTarget: { slug: string; blockId: string; editablePath: string; currentUrl?: string } | null
  chatDarkMode: boolean
  selectionModeEnabled: boolean
  anchorRect: AnchorRect
  anchoredExpanded: boolean
  selectedVariationId: string | null
  showSiteSwitcher: boolean
  copiedDebugEntryId: string | null
  feedbackNoteEntryId: string | null
  feedbackNoteText: string
  siteConfigTab: "overview" | "tone" | "constraints" | "templates"
  configModalTab: "general" | "brief" | "deploy"

  // ── model ───────────────────────────────────────────────────────
  modelKey: ModelKey
  provider: AIProvider
  availableProviders: AIProvider[]
  useStreaming: boolean

  // ── features ────────────────────────────────────────────────────
  backendFeatures: {
    googleDrive?: boolean
    unsplash?: boolean
    imageGenerate?: boolean
    imageGenerateChat?: boolean
    agentMode?: boolean
  }

  // ── debug (from useChatEngine) ──────────────────────────────────
  fieldDraftDebugEnabled: boolean
  fieldDraftDebug: {
    eventsPerSecond: number
    charsPerSecond: number
    totalEvents: number
    totalChars: number
    typingLagChars: number
    activeTarget: string | null
  }
}

// ── Actions ─────────────────────────────────────────────────────────

export type EditorActions = {
  // selection
  setActiveBlock: (id: string | undefined, type?: string | undefined) => void
  setActiveEditablePath: (path: string | undefined) => void

  // navigation
  setSlug: (slug: string) => void
  setAvailableSlugs: (slugs: string[]) => void
  setIsLoadingSlugs: (loading: boolean) => void

  // chat
  setChatLog: (updater: ChatEntry[] | ((prev: ChatEntry[]) => ChatEntry[])) => void
  appendChatEntry: (entry: ChatEntry) => void
  setIsLoading: (loading: boolean) => void
  setStreamStatus: (status: string | null) => void
  setStreamingText: (value: string | null | ((prev: string | null) => string | null)) => void
  setStreamingChanges: (value: string[] | ((prev: string[]) => string[])) => void
  setStreamSteps: (value: { label: string; done: boolean }[] | ((prev: { label: string; done: boolean }[]) => { label: string; done: boolean }[])) => void
  setOpChecklist: (value: { label: string; done: boolean }[] | ((prev: { label: string; done: boolean }[]) => { label: string; done: boolean }[])) => void
  setStreamTokenCount: (value: number | ((prev: number) => number)) => void
  setLatestStreamFocusBlockId: (id: string | null) => void
  setImageProgress: (progress: { percent: number; stage: string } | null) => void
  setContinuationChainId: (id: string | null) => void

  // plan
  setPendingPlanId: (id: string | null) => void
  setPlannerBadgeState: (state: PlannerBadgeState) => void

  // variation
  setVariationModal: (modal: VariationModalState | null) => void
  setIsApplyingVariation: (applying: boolean) => void

  // ui
  setComposerHeight: (value: number | ((prev: number) => number)) => void
  setChatWidth: (value: number | null | ((prev: number | null) => number | null)) => void
  setActiveTab: (tab: "chat" | "properties" | "history") => void
  setShowSettingsModal: (show: boolean) => void
  setShowDebugDetails: (show: boolean) => void
  setAddBlockPicker: (picker: EditorState["addBlockPicker"]) => void
  setAddBlockSearch: (search: string) => void
  setIsAddingBlock: (adding: boolean) => void
  setImagePickerTarget: (target: EditorState["imagePickerTarget"]) => void
  setChatDarkMode: (dark: boolean) => void
  setSelectionModeEnabled: (enabled: boolean) => void
  setAnchorRect: (rect: AnchorRect) => void
  setAnchoredExpanded: (expanded: boolean) => void
  setSelectedVariationId: (id: string | null) => void
  setShowSiteSwitcher: (show: boolean) => void
  setCopiedDebugEntryId: (id: string | null) => void
  setFeedbackNoteEntryId: (id: string | null) => void
  setFeedbackNoteText: (text: string) => void
  setSiteConfigTab: (tab: EditorState["siteConfigTab"]) => void
  setConfigModalTab: (tab: EditorState["configModalTab"]) => void

  // model
  setModelKey: (key: ModelKey) => void
  setProvider: (provider: AIProvider) => void
  setAvailableProviders: (providers: AIProvider[]) => void
  setUseStreaming: (streaming: boolean) => void

  // features
  setBackendFeatures: (features: EditorState["backendFeatures"]) => void

  // debug
  setFieldDraftDebugEnabled: (enabled: boolean) => void
  setFieldDraftDebug: (debug: EditorState["fieldDraftDebug"]) => void

  // composite actions
  pushAssistantFromResult: (data: AssistantResponse, options?: { canUndo?: boolean; undoSlug?: string }) => void
}

// ── Store creation ──────────────────────────────────────────────────

export const useEditorStore = create<EditorState & EditorActions>()(
  subscribeWithSelector((set) => ({
    // ── selection defaults ─────────────────────────────────────────
    activeBlockId: undefined,
    activeBlockType: undefined,
    activeEditablePath: undefined,

    // ── navigation defaults ───────────────────────────────────────
    slug: "/",
    availableSlugs: ["/"],
    isLoadingSlugs: false,

    // ── chat defaults ─────────────────────────────────────────────
    chatLog: [],
    isLoading: false,
    streamStatus: null,
    streamingText: null,
    streamingChanges: [],
    streamSteps: [],
    opChecklist: [],
    streamTokenCount: 0,
    latestStreamFocusBlockId: null,
    imageProgress: null,
    continuationChainId: null,

    // ── plan defaults ─────────────────────────────────────────────
    pendingPlanId: null,
    plannerBadgeState: "checking",

    // ── variation defaults ────────────────────────────────────────
    variationModal: null,
    isApplyingVariation: false,

    // ── ui defaults ───────────────────────────────────────────────
    composerHeight: 56,
    chatWidth: resolveDefaultChatWidth(),
    activeTab: "chat",
    showSettingsModal: false,
    showDebugDetails: resolveDefaultDebugMode(),
    addBlockPicker: null,
    addBlockSearch: "",
    isAddingBlock: false,
    imagePickerTarget: null,
    chatDarkMode: resolveDefaultChatDarkMode(),
    selectionModeEnabled: false,
    anchorRect: null,
    anchoredExpanded: false,
    selectedVariationId: null,
    showSiteSwitcher: false,
    copiedDebugEntryId: null,
    feedbackNoteEntryId: null,
    feedbackNoteText: "",
    siteConfigTab: "overview",
    configModalTab: "general",

    // ── model defaults ────────────────────────────────────────────
    modelKey: resolveDefaultModelKey(),
    provider: resolveDefaultProvider(),
    availableProviders: [],
    useStreaming: true,

    // ── features defaults ─────────────────────────────────────────
    backendFeatures: {},

    // ── debug defaults ────────────────────────────────────────────
    fieldDraftDebugEnabled: false,
    fieldDraftDebug: {
      eventsPerSecond: 0,
      charsPerSecond: 0,
      totalEvents: 0,
      totalChars: 0,
      typingLagChars: 0,
      activeTarget: null,
    },

    // ── selection actions ─────────────────────────────────────────
    setActiveBlock: (id, type) =>
      set((prev) => {
        if (prev.activeBlockId === id && prev.activeBlockType === type) return prev
        return { ...prev, activeBlockId: id, activeBlockType: type }
      }),
    setActiveEditablePath: (path) =>
      set((prev) => (prev.activeEditablePath === path ? prev : { ...prev, activeEditablePath: path })),

    // ── navigation actions ────────────────────────────────────────
    setSlug: (slug) =>
      set((prev) => (prev.slug === slug ? prev : { ...prev, slug })),
    setAvailableSlugs: (slugs) => set({ availableSlugs: slugs }),
    setIsLoadingSlugs: (loading) =>
      set((prev) => (prev.isLoadingSlugs === loading ? prev : { ...prev, isLoadingSlugs: loading })),

    // ── chat actions ──────────────────────────────────────────────
    setChatLog: (updater) =>
      set((prev) => ({
        ...prev,
        chatLog: typeof updater === "function" ? updater(prev.chatLog) : updater,
      })),
    appendChatEntry: (entry) =>
      set((prev) => ({ ...prev, chatLog: [...prev.chatLog, entry] })),
    setIsLoading: (loading) =>
      set((prev) => (prev.isLoading === loading ? prev : { ...prev, isLoading: loading })),
    setStreamStatus: (status) => set({ streamStatus: status }),
    setStreamingText: (value) =>
      set((prev) => ({
        ...prev,
        streamingText: typeof value === "function" ? value(prev.streamingText) : value,
      })),
    setStreamingChanges: (value) =>
      set((prev) => ({
        ...prev,
        streamingChanges: typeof value === "function" ? value(prev.streamingChanges) : value,
      })),
    setStreamSteps: (value) =>
      set((prev) => ({
        ...prev,
        streamSteps: typeof value === "function" ? value(prev.streamSteps) : value,
      })),
    setOpChecklist: (value) =>
      set((prev) => ({
        ...prev,
        opChecklist: typeof value === "function" ? value(prev.opChecklist) : value,
      })),
    setStreamTokenCount: (value) =>
      set((prev) => ({
        ...prev,
        streamTokenCount: typeof value === "function" ? value(prev.streamTokenCount) : value,
      })),
    setLatestStreamFocusBlockId: (id) => set({ latestStreamFocusBlockId: id }),
    setImageProgress: (progress) => set({ imageProgress: progress }),
    setContinuationChainId: (id) => set({ continuationChainId: id }),

    // ── plan actions ──────────────────────────────────────────────
    setPendingPlanId: (id) => set({ pendingPlanId: id }),
    setPlannerBadgeState: (state) => set({ plannerBadgeState: state }),

    // ── variation actions ─────────────────────────────────────────
    setVariationModal: (modal) => set({ variationModal: modal }),
    setIsApplyingVariation: (applying) => set({ isApplyingVariation: applying }),

    // ── ui actions ────────────────────────────────────────────────
    setComposerHeight: (value) =>
      set((prev) => {
        const next = typeof value === "function" ? value(prev.composerHeight) : value
        return prev.composerHeight === next ? prev : { ...prev, composerHeight: next }
      }),
    setChatWidth: (value) =>
      set((prev) => {
        const next = typeof value === "function" ? value(prev.chatWidth) : value
        return prev.chatWidth === next ? prev : { ...prev, chatWidth: next }
      }),
    setActiveTab: (tab) =>
      set((prev) => (prev.activeTab === tab ? prev : { ...prev, activeTab: tab })),
    setShowSettingsModal: (show) => set({ showSettingsModal: show }),
    setShowDebugDetails: (show) => set({ showDebugDetails: show }),
    setAddBlockPicker: (picker) => set({ addBlockPicker: picker }),
    setAddBlockSearch: (search) => set({ addBlockSearch: search }),
    setIsAddingBlock: (adding) => set({ isAddingBlock: adding }),
    setImagePickerTarget: (target) => set({ imagePickerTarget: target }),
    setChatDarkMode: (dark) =>
      set((prev) => (prev.chatDarkMode === dark ? prev : { ...prev, chatDarkMode: dark })),
    setSelectionModeEnabled: (enabled) => set({ selectionModeEnabled: enabled }),
    setAnchorRect: (rect) => set({ anchorRect: rect }),
    setAnchoredExpanded: (expanded) => set({ anchoredExpanded: expanded }),
    setSelectedVariationId: (id) => set({ selectedVariationId: id }),
    setShowSiteSwitcher: (show) => set({ showSiteSwitcher: show }),
    setCopiedDebugEntryId: (id) => set({ copiedDebugEntryId: id }),
    setFeedbackNoteEntryId: (id) => set({ feedbackNoteEntryId: id }),
    setFeedbackNoteText: (text) => set({ feedbackNoteText: text }),
    setSiteConfigTab: (tab) => set({ siteConfigTab: tab }),
    setConfigModalTab: (tab) => set({ configModalTab: tab }),

    // ── model actions ─────────────────────────────────────────────
    setModelKey: (key) =>
      set((prev) => (prev.modelKey === key ? prev : { ...prev, modelKey: key })),
    setProvider: (provider) =>
      set((prev) => (prev.provider === provider ? prev : { ...prev, provider: provider })),
    setAvailableProviders: (providers) => set({ availableProviders: providers }),
    setUseStreaming: (streaming) => set({ useStreaming: streaming }),

    // ── features actions ──────────────────────────────────────────
    setBackendFeatures: (features) => set({ backendFeatures: features }),

    // ── debug actions ─────────────────────────────────────────────
    setFieldDraftDebugEnabled: (enabled) => set({ fieldDraftDebugEnabled: enabled }),
    setFieldDraftDebug: (debug) => set({ fieldDraftDebug: debug }),

    // ── composite actions ─────────────────────────────────────────
    pushAssistantFromResult: (data, options) => {
      const errors = normalizeValidationErrors(data.validationErrors)
      const parsedChanges = splitAiInsightChanges(data.changes)
      const entry: ChatEntry = {
        id: createId(),
        role: "assistant",
        text: data.summary ?? data.error ?? "Request failed.",
        status: data.status,
        canUndo: options?.canUndo ?? false,
        wasUndone: false,
        undoSlug: options?.undoSlug,
        changes: parsedChanges.changes,
        mentionedSlugs: Array.isArray(data.mentionedSlugs)
          ? data.mentionedSlugs.filter((s): s is string => typeof s === "string")
          : [],
        suggestions: data.suggestions ?? [],
        variations: data.variations,
        errors,
        meta: data.modelUsed
          ? `${data.modelUsed}${data.modelKey ? ` (${data.modelKey})` : ""}`
          : undefined,
        debug: data.debug,
        aiJustification: parsedChanges.aiJustification,
        aiPerformanceNote: parsedChanges.aiPerformanceNote,
        pendingPlanId: typeof data.pendingPlanId === "string" ? data.pendingPlanId : undefined,
        continuation: data.continuation ?? undefined,
      }

      set((prev) => {
        if (!entry.canUndo) return { ...prev, chatLog: [...prev.chatLog, entry] }
        const withoutUndo = prev.chatLog.map((row) =>
          row.canUndo ? { ...row, canUndo: false, wasUndone: false } : row
        )
        return { ...prev, chatLog: [...withoutUndo, entry] }
      })
    },
  }))
)

// ── Centralized side effects ────────────────────────────────────────
// Replaces ~8 scattered useEffect calls in EditorPage that sync state
// to localStorage/DOM.  Coverage is structural: any mutation path that
// changes these fields triggers the effect.

useEditorStore.subscribe(
  (s) => s.chatDarkMode,
  (dark) => {
    if (typeof window === "undefined") return
    const root = window.document.documentElement
    root.classList.toggle("editor-dark", dark)
    window.sessionStorage.setItem(CHAT_THEME_STORAGE_KEY, dark ? "dark" : "light")
    window.localStorage.setItem(CHAT_THEME_STORAGE_KEY, dark ? "dark" : "light")
  }
)

useEditorStore.subscribe(
  (s) => s.modelKey,
  (key) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(MODEL_KEY_STORAGE_KEY, key)
  }
)

useEditorStore.subscribe(
  (s) => s.provider,
  (provider) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider)
  }
)

useEditorStore.subscribe(
  (s) => s.showDebugDetails,
  (show) => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, show ? "1" : "0")
  }
)

useEditorStore.subscribe(
  (s) => s.chatWidth,
  (width) => {
    if (typeof window === "undefined") return
    if (width == null) window.localStorage.removeItem(CHAT_WIDTH_STORAGE_KEY)
    else window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(width)))
  }
)
