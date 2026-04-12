import { useEffect, useRef, useState } from "react"
import { useT } from "../i18n"
import {
  type BlockManifest,
  type Operation
} from "@ai-site-editor/shared"
import type {
  AssistantResponse,
  ChatEntry,
  ChatExecutionMode,
  SiteCapabilities,
  SiteConfig
} from "../lib/editor-types"
import {
  createId,
  enablePatchTransport,
  isComplexTaskRequest,
  isVariationRequest,
  orchestrator,
  resolveSiteOrigin,
  siteOrigin,
  splitAiInsightChanges
} from "../lib/editor-utils"
import { buildSiteContextPayload, manifestUnavailableChanges, withIntegrationContext } from "../lib/integration-context"
import { withAccessTokenQuery } from "../lib/access-auth"
import { parseString } from "../lib/parse-utils"
import { usePlanApproval } from "./chat-engine/usePlanApproval"
import { useStructuralOps } from "./chat-engine/useStructuralOps"
import { useUndoHistory } from "./chat-engine/useUndoHistory"
import { useVariations } from "./chat-engine/useVariations"
import { submitAgentStream } from "./chat-engine/agent-transport"
import { useEditorStore } from "../store"
import { getSessionId, getSiteId } from "../store/session"
import type { PreviewBridgeFns } from "./chat-engine/types"

export type ChatEngineConfig = PreviewBridgeFns & {
  activeSiteConfig: SiteConfig
  componentManifest?: BlockManifest | null
  siteCapabilities?: SiteCapabilities
  allowStructuralEdits: boolean
  getBlockDefaultProps?: (blockType: string) => Record<string, unknown> | null
  onApplied?: () => void
  agentModeEnabled?: boolean
}

function normalizeValidationErrors(raw: AssistantResponse["validationErrors"]) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  const field = Object.values(raw.fieldErrors ?? {}).flat().map(String)
  const form = (raw.formErrors ?? []).map(String)
  return [...form, ...field]
}

export function useChatEngine(config: ChatEngineConfig) {
  const {
    activeSiteConfig,
    postToSite,
    postPatchToSite,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
    onApplied
  } = config

  const store = useEditorStore
  const { t, locale } = useT()
  const session = getSessionId()
  const siteId = getSiteId()
  const activeSiteOrigin = resolveSiteOrigin(activeSiteConfig)
  const chatLogStorageKey = `editor-chat-log-v1:${session}:${siteId}`

  const blockIdFromOperation = (op?: Operation) => {
    if (!op || typeof op !== "object") return null
    if ("blockId" in op && typeof op.blockId === "string" && op.blockId.length > 0) return op.blockId
    if (op.op === "add_block" && op.block && typeof op.block.id === "string" && op.block.id.length > 0) return op.block.id
    if (op.op === "duplicate_block" && typeof op.newBlockId === "string" && op.newBlockId.length > 0) return op.newBlockId
    return null
  }

  const labelFromOperation = (op: unknown): string => {
    if (!op || typeof op !== "object") return "Processing"
    const rec = op as Record<string, unknown>
    const opType = String(rec.op ?? rec.type ?? "")
    const blockType =
      (rec.block && typeof rec.block === "object" ? (rec.block as Record<string, unknown>).type : null) ??
      rec.blockType ?? null
    const verb: Record<string, string> = {
      add_block: "Add",
      remove_block: "Remove",
      update_props: "Update",
      update_item: "Update item in",
      add_item: "Add item to",
      remove_item: "Remove item from",
      move_block: "Move",
      duplicate_block: "Duplicate",
      update_page_meta: "Update page metadata",
    }
    const action = verb[opType] ?? opType.replace(/_/g, " ")
    if (opType === "update_page_meta") return action
    if (typeof blockType === "string") return `${action} ${blockType}`
    return action
  }

  function buildWelcomeSuggestions(
    cfg: SiteConfig,
    slugs: string[],
    manifest?: BlockManifest | null,
    pageBlocks?: Array<{ type: string }>
  ): string[] {
    const suggestions: string[] = []
    const supported = new Set(manifest?.blocks?.map((b: { type: string }) => b.type) ?? [])

    if (pageBlocks && pageBlocks.length > 0) {
      const onPage = new Set(pageBlocks.map(b => b.type))
      if (onPage.has("Hero")) suggestions.push(t("suggestion.rewriteHero"))
      if (!onPage.has("Testimonials") && supported.has("Testimonials")) suggestions.push(t("suggestion.addTestimonials"))
      if (!onPage.has("FAQAccordion") && supported.has("FAQAccordion")) suggestions.push(t("suggestion.addFaq"))
      if (!onPage.has("CTA") && supported.has("CTA")) suggestions.push(t("suggestion.addCta"))
    } else {
      suggestions.push(t("suggestion.changeHeadline"))
      if (supported.has("Testimonials")) suggestions.push(t("suggestion.addTestimonials"))
      if (supported.has("FAQAccordion")) suggestions.push(t("suggestion.addFaq"))
      if (supported.has("CTA")) suggestions.push(t("suggestion.addCta"))
      if (suggestions.length < 2) suggestions.push(t("suggestion.addSection"))
    }

    if (cfg.tone) {
      suggestions.push(t("suggestion.rewriteTone", { tone: cfg.tone }))
    }

    if (cfg.pageTemplates?.length) {
      suggestions.push(t("suggestion.createFromTemplate", { name: cfg.pageTemplates[0].name }))
    } else if (!slugs.includes("/about")) {
      suggestions.push(t("suggestion.createAbout"))
    }

    return suggestions.slice(0, 4)
  }

  const welcomeText = activeSiteConfig.name
    ? t("welcome.greeting", { name: activeSiteConfig.name })
    : t("welcome.greetingFallback")

  const buildWelcomeEntry = (slugs?: string[], blocks?: Array<{ type: string }>): ChatEntry => ({
    id: "welcome",
    role: "assistant",
    text: welcomeText,
    suggestions: buildWelcomeSuggestions(activeSiteConfig, slugs ?? store.getState().availableSlugs, componentManifest, blocks)
  })

  // Initialize chatLog from localStorage on first mount
  const chatLogInitializedRef = useRef(false)
  if (!chatLogInitializedRef.current) {
    chatLogInitializedRef.current = true
    let initial: ChatEntry[] | null = null
    try {
      const stored = localStorage.getItem(chatLogStorageKey)
      if (stored) {
        const parsed = JSON.parse(stored) as ChatEntry[]
        if (Array.isArray(parsed) && parsed.length > 0) initial = parsed
      }
    } catch { /* ignore corrupt data */ }
    store.getState().setChatLog(initial ?? [buildWelcomeEntry()])
  }

  // Persist chatLog to localStorage
  const chatLog = useEditorStore((s) => s.chatLog)
  useEffect(() => {
    try {
      const toStore = chatLog.slice(-50).map(({ status, ...rest }) => rest)
      localStorage.setItem(chatLogStorageKey, JSON.stringify(toStore))
    } catch { /* ignore quota errors */ }
  }, [chatLog, chatLogStorageKey])

  // Convenience aliases for store actions used frequently in streaming
  const setChatLog = store.getState().setChatLog
  const setIsLoading = store.getState().setIsLoading
  const setStreamStatus = store.getState().setStreamStatus
  const setStreamTokenCount = store.getState().setStreamTokenCount
  const setImageProgress = store.getState().setImageProgress
  const setLatestStreamFocusBlockId = store.getState().setLatestStreamFocusBlockId
  const setStreamingText = store.getState().setStreamingText
  const setStreamingChanges = store.getState().setStreamingChanges
  const setStreamSteps = store.getState().setStreamSteps
  const setOpChecklist = store.getState().setOpChecklist
  const setFieldDraftDebug = store.getState().setFieldDraftDebug
  const setActiveBlockId = (id: string | undefined) => store.getState().setActiveBlock(id)
  const setActiveBlockType = (_type: string | undefined) => { /* absorbed into setActiveBlock */ }
  const setActiveEditablePath = store.getState().setActiveEditablePath
  const setSlug = store.getState().setSlug
  const setAvailableSlugs = store.getState().setAvailableSlugs
  const setIsLoadingSlugs = store.getState().setIsLoadingSlugs
  const pushAssistantFromResult = store.getState().pushAssistantFromResult
  const setContinuationChainId = store.getState().setContinuationChainId

  // Track last sent message so server-forced plan_only can populate pendingPlanMessage
  const lastSentMessageRef = useRef<string | null>(null)
  const activeStreamIdRef = useRef<string | null>(null)
  const agentCancelRef = useRef<(() => void) | null>(null)

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource === "openai" || data.plannerSource === "anthropic" || data.plannerSource === "gemini" || data.plannerSource === "demo") {
      store.getState().setPlannerBadgeState(data.plannerSource)
    }
    if (data.status === "plan_ready" && typeof data.pendingPlanId === "string" && data.pendingPlanId.length > 0) {
      store.getState().setPendingPlanId(data.pendingPlanId)
      // Server may force plan_only (e.g. for image generation) on a non-complex message.
      // Ensure pendingPlanMessage is populated so approval sends the original text.
      planApproval.setPendingPlanMessage((prev) => prev ?? lastSentMessageRef.current)
    } else if (data.status === "applied" || data.status === "canceled") {
      store.getState().setPendingPlanId(null)
      planApproval.setPendingPlanMessage(null)
    }
    if (data.status === "applied") {
      setLatestStreamFocusBlockId(data.focusBlockId ?? null)
    }
    if (data.continuation?.chainId) {
      setContinuationChainId(data.continuation.chainId)
    } else {
      setContinuationChainId(null)
    }
    // undoSlug tells the editor which slug's undo stack to pop.
    // Server sends it explicitly; fall back to current slug for older responses.
    const currentSlugNow = store.getState().slug
    const undoSlug = typeof data.undoSlug === "string" && data.undoSlug.length > 0
      ? data.undoSlug
      : currentSlugNow
    pushAssistantFromResult(data, { canUndo: data.status === "applied", undoSlug })
    if (data.status === "applied") {
      const currentSlug = store.getState().slug
      const nextSlug = parseString(data.updatedSlug, currentSlug)
      if (nextSlug !== currentSlug) {
        setSlug(nextSlug)
        store.getState().setActiveBlock(undefined, undefined)
        setActiveEditablePath(undefined)
      }
      const navigateTo = nextSlug !== currentSlug ? nextSlug : undefined
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null, navigateTo })
      if (data.focusBlockId) {
        store.getState().setActiveBlock(data.focusBlockId)
      }
      setActiveEditablePath(undefined)
      void refreshRouteSlugs()
      onApplied?.()
      // After ops are applied, undo is available and redo stack is cleared
      undoHistory.setCanUndoServer(true)
      undoHistory.setCanRedoServer(false)
    }
  }

  async function bootstrapFromSite(): Promise<{ slugs: string[]; synced: boolean }> {
    try {
      const bootstrapSourceRes = await fetch(`${activeSiteOrigin}/api/editor/pages?siteId=${encodeURIComponent(siteId)}`)
      if (!bootstrapSourceRes.ok) return { slugs: [], synced: false }
      const bootstrapSource = (await bootstrapSourceRes.json()) as { pages?: unknown }
      if (!Array.isArray(bootstrapSource.pages) || bootstrapSource.pages.length === 0) return { slugs: [], synced: false }

      // Only overwrite orchestrator state if the site returns pages with actual content.
      // If all pages have 0 blocks, the CMS read layer may not support block relations —
      // don't destroy richer in-memory state from previous editing sessions.
      const sitePages = bootstrapSource.pages as Array<{ blocks?: unknown[] }>
      const hasContent = sitePages.some((p) => Array.isArray(p.blocks) && p.blocks.length > 0)

      const bootstrapRes = await fetch(`${orchestrator}/draft/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session,
          siteId,
          pages: bootstrapSource.pages,
          overwrite: hasContent
        })
      })
      if (!bootstrapRes.ok) return { slugs: [], synced: false }
      const bootstrapData = (await bootstrapRes.json()) as { slugs?: string[] }
      return { slugs: bootstrapData.slugs ?? [], synced: true }
    } catch {
      return { slugs: [], synced: false }
    }
  }

  async function syncFromSite(): Promise<number> {
    setIsLoadingSlugs(true)
    try {
      const result = await bootstrapFromSite()
      if (result.synced && result.slugs.length > 0) {
        setAvailableSlugs(result.slugs)
        postToSite("draftUpdated", { focusBlockId: null })
      }
      return result.slugs.length
    } finally {
      setIsLoadingSlugs(false)
    }
  }

  // Track whether the initial bootstrap has happened for this session
  const hasBootstrappedRef = useRef(false)
  const [hasBootstrapped, setHasBootstrapped] = useState(false)

  async function updateWelcomeSuggestions(slugs: string[]) {
    try {
      const pageUrl = `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(store.getState().slug)}`
      const pageRes = await fetch(pageUrl)
      if (!pageRes.ok) return
      const pageDoc = (await pageRes.json()) as { blocks?: Array<{ type: string }> }
      const blocks = Array.isArray(pageDoc.blocks) ? pageDoc.blocks : undefined
      const updated = buildWelcomeSuggestions(activeSiteConfig, slugs, componentManifest, blocks)
      store.getState().setChatLog(prev => prev.map(entry =>
        entry.id === "welcome" ? { ...entry, suggestions: updated } : entry
      ))
    } catch { /* non-critical — keep initial suggestions */ }
  }

  async function refreshRouteSlugs() {
    setIsLoadingSlugs(true)
    try {
      const slugsUrl = `${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
      const res = await fetch(slugsUrl)
      if (!res.ok) return store.getState().availableSlugs
      const data = (await res.json()) as { slugs?: unknown }
      const list = Array.isArray(data.slugs)
        ? data.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []

      // On first load for this session, always sync from the site to pick up CMS changes
      if (!hasBootstrappedRef.current) {
        hasBootstrappedRef.current = true
        const bootstrapResult = await bootstrapFromSite()
        setHasBootstrapped(true)
        if (bootstrapResult.synced && bootstrapResult.slugs.length > 0) {
          setAvailableSlugs(bootstrapResult.slugs)
          void updateWelcomeSuggestions(bootstrapResult.slugs)
          return bootstrapResult.slugs
        }
      }

      if (list.length > 0) {
        if (!hasBootstrapped) setHasBootstrapped(true)
        setAvailableSlugs(list)
        void updateWelcomeSuggestions(list)
        return list
      }

      return store.getState().availableSlugs
    } catch {
      return store.getState().availableSlugs
    } finally {
      setIsLoadingSlugs(false)
    }
  }

  async function submitChatHttp(finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string; continuationChainId?: string }) {
    const { slug: currentSlug, activeBlockId, activeBlockType, activeEditablePath, modelKey, provider } = store.getState()
    const contextPayload = buildSiteContextPayload(siteId, activeSiteConfig)
    const res = await fetch(`${orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
        session,
        siteId,
        ...contextPayload,
        locale,
        slug: currentSlug,
        message: finalMessage,
        modelKey,
        provider,
        activeBlockId,
        activeBlockType,
        activeEditablePath,
        executionMode: options?.executionMode ?? "auto",
        pendingPlanId: options?.pendingPlanId,
        ...(options?.continuationChainId ? { continuationChainId: options.continuationChainId } : {})
      }, componentManifest, siteCapabilities))
    })

    const data = (await res.json()) as AssistantResponse
    applyChatResult(data)
  }

  async function submitChatStream(finalMessage: string, extraParams?: Record<string, string>) {
    const { slug: currentSlug, activeBlockId, activeBlockType, activeEditablePath, modelKey, provider } = store.getState()
    const contextPayload = buildSiteContextPayload(siteId, activeSiteConfig)
    const payload = withIntegrationContext({
      session,
      siteId,
      ...contextPayload,
      locale,
      slug: currentSlug,
      message: finalMessage,
      modelKey,
      provider,
      activeBlockId,
      activeBlockType,
      activeEditablePath,
      ...(extraParams ?? {})
    }, componentManifest, siteCapabilities)

    // Show immediate feedback before any SSE events arrive
    setStreamStatus(t("stream.thinking"))

    let streamId: string
    try {
      const res = await fetch(`${orchestrator}/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
      if (!res.ok) return false
      const data = await res.json() as { streamId?: string }
      if (!data.streamId) return false
      streamId = data.streamId
      activeStreamIdRef.current = streamId
    } catch {
      return false
    }

    return await new Promise<boolean>((resolve) => {
      let lastSeq = 0
      const storageKey = `chat-stream:${session}:${siteId}`

      const persistStreamContext = () => {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify({ streamId, lastSeq }))
        } catch { /* quota exceeded or unavailable */ }
      }

      const clearStreamContext = () => {
        activeStreamIdRef.current = null
        try { sessionStorage.removeItem(storageKey) } catch { /* ignore */ }
      }

      persistStreamContext()

      const source = new EventSource(withAccessTokenQuery(`${orchestrator}/chat/stream?streamId=${streamId}`))
      let settled = false
      let gotAnyEvent = false
      let pendingFocusBlockId: string | null = null
      let opRefreshTimer: number | null = null
      let lastOpAppliedAt = 0
      let lastOpTotal = 0
      let appliedOpCount = 0
      let skippedOpCount = 0
      let liveDraftBlockId: string | null = store.getState().activeBlockId ?? null
      let liveDraftText = ""
      let liveDraftFlushTimer: number | null = null
      let liveDraftTypingTimer: number | null = null
      let liveDraftDeferredEndTimer: number | null = null
      let liveDraftTypingTarget: { blockId: string; editablePath: string } | null = null
      let liveDraftTypingRendered = ""
      let liveDraftTypingDesired = ""
      let liveDraftEndDeferred = false
      let liveDraftActive = false
      let liveDraftFields: Record<string, string> | null = null
      let sawFieldDraftThisRun = false
      let currentStepLabel: string | null = null
      let currentStepRank = 0
      const debugDraftEnabled = store.getState().fieldDraftDebugEnabled
      let debugFlushTimer: number | null = null
      const debugFieldEventAtMs: number[] = []
      const debugFieldCharAt: Array<{ at: number; chars: number }> = []
      const debugPrevValueLenByField = new Map<string, number>()
      let debugTotalFieldEvents = 0
      let debugTotalFieldChars = 0
      let debugTypingLagChars = 0
      let debugActiveTarget: string | null = null
      let debugNeedsFlush = false

      /** Advance the progress stepper: mark previous step done, add new active step */
      const normalizeStepLabel = (s: string) =>
        s.replace(/[\u2026.]+$/, "").replace(/\s*\([\d/,\s]+\)$/, "").trim()
      // Classify a raw orchestrator status tone into a user-facing phase.
      // The rank is monotonic — a trailing server tone that would move the
      // stepper backwards (e.g. a late "Planning…" after op_applied already
      // fired) is rejected by advanceStep. The label collapses the 10 pre-op
      // tones (analyzing, understanding, thinking, validating, repairing, …)
      // into one stable string; plan_meta and op_applied labels pass through
      // unchanged because they carry user-visible counts.
      const classifyServerStep = (raw: string): { label: string; rank: number } => {
        const lower = raw.toLowerCase()
        if (/resolving image|collecting image|preparing image/.test(lower)) return { label: "Resolving images…", rank: 4 }
        if (/^applying/.test(lower) || /updating draft/.test(lower)) return { label: raw, rank: 3 }
        if (/^plan ready/.test(lower)) return { label: raw, rank: 2 }
        return { label: "Planning…", rank: 1 }
      }
      // Returns the accepted (possibly collapsed) label, or null when the
      // event was rejected because it would regress the phase. Callers that
      // also update streamStatus should only do so on a non-null return,
      // otherwise the single-line status pill will flip backwards behind
      // the stepper's back.
      const advanceStep = (rawLabel: string): string | null => {
        const { label, rank } = classifyServerStep(rawLabel)
        if (rank < currentStepRank) return null
        const baseLabel = normalizeStepLabel(label)
        const prevBase = currentStepLabel ? normalizeStepLabel(currentStepLabel) : null
        currentStepLabel = label
        currentStepRank = rank
        const display = label.replace(/[\u2026.]+$/, "").trim()
        if (baseLabel === prevBase) {
          // Same phase — update the display label in-place (e.g. "Applying changes (3/8)")
          setStreamSteps((prev) => {
            if (prev.length === 0) return prev
            const last = prev[prev.length - 1]
            if (last.done || last.label === display) return prev
            return [...prev.slice(0, -1), { ...last, label: display }]
          })
          return label
        }
        setStreamSteps((prev) => {
          const next = prev.map((s) => (s.done ? s : { ...s, done: true }))
          next.push({ label: display, done: false })
          return next
        })
        return label
      }

      const sendLiveDraft = (force = false, commit = false) => {
        if (!liveDraftBlockId) return
        if (!force && !liveDraftActive) return
        postToSite("liveDraft", {
          blockId: liveDraftBlockId,
          text: liveDraftText.slice(0, 2400),
          active: liveDraftActive,
          ...(liveDraftFields ? { fields: liveDraftFields } : {}),
          ...(commit ? { commit: true } : {})
        })
      }

      const clearDebugFlushTimer = () => {
        if (debugFlushTimer === null) return
        window.clearTimeout(debugFlushTimer)
        debugFlushTimer = null
      }

      const flushFieldDraftDebug = () => {
        if (!debugDraftEnabled || !debugNeedsFlush) return
        debugNeedsFlush = false
        const now = Date.now()
        const windowStart = now - 1000
        while (debugFieldEventAtMs.length > 0 && debugFieldEventAtMs[0]! < windowStart) {
          debugFieldEventAtMs.shift()
        }
        while (debugFieldCharAt.length > 0 && debugFieldCharAt[0]!.at < windowStart) {
          debugFieldCharAt.shift()
        }
        const charsPerSecond = debugFieldCharAt.reduce((sum, item) => sum + item.chars, 0)
        setFieldDraftDebug({
          eventsPerSecond: debugFieldEventAtMs.length,
          charsPerSecond,
          totalEvents: debugTotalFieldEvents,
          totalChars: debugTotalFieldChars,
          typingLagChars: debugTypingLagChars,
          activeTarget: debugActiveTarget
        })
      }

      const scheduleFieldDraftDebugFlush = () => {
        if (!debugDraftEnabled) return
        debugNeedsFlush = true
        if (debugFlushTimer !== null) return
        debugFlushTimer = window.setTimeout(() => {
          debugFlushTimer = null
          flushFieldDraftDebug()
        }, 120)
      }

      const clearLiveDraftTimer = () => {
        if (liveDraftFlushTimer === null) return
        window.clearTimeout(liveDraftFlushTimer)
        liveDraftFlushTimer = null
      }

      const scheduleLiveDraftFlush = () => {
        clearLiveDraftTimer()
        liveDraftFlushTimer = window.setTimeout(() => {
          liveDraftFlushTimer = null
          sendLiveDraft(true)
        }, 16)
      }

      const clearLiveDraftTypingTimer = () => {
        if (liveDraftTypingTimer === null) return
        window.clearTimeout(liveDraftTypingTimer)
        liveDraftTypingTimer = null
      }

      const clearLiveDraftDeferredEndTimer = () => {
        if (liveDraftDeferredEndTimer === null) return
        window.clearTimeout(liveDraftDeferredEndTimer)
        liveDraftDeferredEndTimer = null
      }

      const resetLiveDraftTyping = () => {
        clearLiveDraftTypingTimer()
        clearLiveDraftDeferredEndTimer()
        liveDraftEndDeferred = false
        liveDraftTypingTarget = null
        liveDraftTypingRendered = ""
        liveDraftTypingDesired = ""
        debugTypingLagChars = 0
        debugActiveTarget = null
        scheduleFieldDraftDebugFlush()
      }

      const shouldAnimateFieldDraftText = (editablePath: string, value: string) => {
        const path = editablePath.toLowerCase()
        if (/(^|[.\]])(imageurl|href|url|src|ctahref)(?=$|[.[\]])/.test(path)) return false
        const trimmed = value.trim()
        if (/^(https?:\/\/|\/|#|data:|mailto:|tel:)/i.test(trimmed)) return false
        return true
      }

      const commonPrefixLength = (a: string, b: string) => {
        const max = Math.min(a.length, b.length)
        let idx = 0
        while (idx < max && a[idx] === b[idx]) idx += 1
        return idx
      }

      const runLiveDraftTypingTick = () => {
        const target = liveDraftTypingTarget
        if (!target) return
        if (!liveDraftActive || liveDraftBlockId !== target.blockId) return
        if (liveDraftTypingRendered === liveDraftTypingDesired) {
          debugTypingLagChars = 0
          scheduleFieldDraftDebugFlush()
          if (liveDraftEndDeferred) {
            clearLiveDraftDeferredEndTimer()
            liveDraftDeferredEndTimer = window.setTimeout(() => {
              liveDraftDeferredEndTimer = null
              if (!liveDraftEndDeferred) return
              if (liveDraftTypingRendered !== liveDraftTypingDesired) return
              liveDraftEndDeferred = false
              endLiveDraft(true)
            }, 64)
          }
          return
        }

        const lcp = commonPrefixLength(liveDraftTypingRendered, liveDraftTypingDesired)
        if (liveDraftTypingRendered.length > lcp) {
          const backlog = liveDraftTypingRendered.length - lcp
          const deleteStep = backlog > 40 ? 3 : backlog > 15 ? 2 : 1
          liveDraftTypingRendered = liveDraftTypingRendered.slice(0, Math.max(lcp, liveDraftTypingRendered.length - deleteStep))
        } else {
          const backlog = liveDraftTypingDesired.length - liveDraftTypingRendered.length
          const advance =
            backlog > 140 ? 6 :
            backlog > 90 ? 5 :
            backlog > 60 ? 4 :
            backlog > 30 ? 3 :
            backlog > 10 ? 2 : 1
          liveDraftTypingRendered = liveDraftTypingDesired.slice(0, Math.min(liveDraftTypingDesired.length, liveDraftTypingRendered.length + advance))
        }

        liveDraftFields = { [target.editablePath]: liveDraftTypingRendered }
        debugTypingLagChars = Math.max(0, liveDraftTypingDesired.length - liveDraftTypingRendered.length)
        scheduleFieldDraftDebugFlush()
        scheduleLiveDraftFlush()

        if (liveDraftTypingRendered !== liveDraftTypingDesired) {
          const backlog = liveDraftTypingDesired.length - liveDraftTypingRendered.length
          const nextChar = liveDraftTypingDesired[liveDraftTypingRendered.length] ?? ""
          const delayMs =
            nextChar === "\n" ? 78 :
            /[.!?]/.test(nextChar) ? 68 :
            /[,;:]/.test(nextChar) ? 42 :
            /\s/.test(nextChar) ? 12 :
            backlog > 120 ? 3 :
            backlog > 70 ? 5 :
            backlog > 30 ? 7 : 9
          if (liveDraftTypingTimer === null) {
            liveDraftTypingTimer = window.setTimeout(() => {
              liveDraftTypingTimer = null
              runLiveDraftTypingTick()
            }, delayMs)
          }
        }
      }

      const deferEndLiveDraftUntilTypingSettles = () => {
        liveDraftEndDeferred = true
        clearLiveDraftDeferredEndTimer()
        runLiveDraftTypingTick()
      }

      const beginOrUpdateLiveDraftTyping = (blockId: string, editablePath: string, value: string) => {
        liveDraftEndDeferred = false
        clearLiveDraftDeferredEndTimer()
        if (!shouldAnimateFieldDraftText(editablePath, value)) {
          resetLiveDraftTyping()
          liveDraftBlockId = blockId
          liveDraftFields = { [editablePath]: value }
          liveDraftActive = true
          scheduleLiveDraftFlush()
          return
        }

        const switchedTarget =
          !liveDraftTypingTarget ||
          liveDraftTypingTarget.blockId !== blockId ||
          liveDraftTypingTarget.editablePath !== editablePath

        liveDraftBlockId = blockId
        liveDraftActive = true

        if (switchedTarget) {
          clearLiveDraftTypingTimer()
          liveDraftTypingTarget = { blockId, editablePath }
          liveDraftTypingRendered = ""
          liveDraftTypingDesired = value
          debugActiveTarget = `${blockId}:${editablePath}`
          liveDraftFields = { [editablePath]: "" }
          scheduleLiveDraftFlush()
          scheduleFieldDraftDebugFlush()
          runLiveDraftTypingTick()
          return
        }

        liveDraftTypingDesired = value
        debugActiveTarget = `${blockId}:${editablePath}`
        scheduleFieldDraftDebugFlush()
        runLiveDraftTypingTick()
      }

      // commit=true means the optimistic DOM already matches the committed
      // server state, so the iframe should discard saved originals instead of
      // restoring them. Use after op_applied; leave false for rollback/cancel
      // paths where we genuinely need to revert the live-draft DOM hack.
      const endLiveDraft = (commit = false) => {
        clearLiveDraftTimer()
        resetLiveDraftTyping()
        if (!liveDraftBlockId && !liveDraftActive) return
        liveDraftActive = false
        sendLiveDraft(true, commit)
        liveDraftText = ""
        liveDraftFields = null
      }

      const flushOpRefresh = () => {
        const focusId = pendingFocusBlockId
        postToSite("draftUpdated", { focusBlockId: focusId })
        if (focusId) {
          store.getState().setActiveBlock(focusId)
        }
        store.getState().setActiveEditablePath(undefined)
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
        }, 50)
      }

      source.onmessage = (event) => {
        let payload: {
          type: "status" | "token" | "field_draft" | "plan_meta" | "op_candidate" | "op_applied" | "op_skipped" | "heartbeat" | "rollback_started" | "rollback_done" | "final" | "error" | "canceled" | "summary_token" | "changelog_entry" | "image_progress"
          _seq?: number
          message?: string
          text?: string
          blockId?: string
          editablePath?: string
          value?: string
          stage?: string
          label?: string
          percent?: number
          elapsedMs?: number
          intent?: string
          summary?: string
          estimatedOps?: number
          index?: number
          total?: number
          op?: Operation
          reason?: string
          previewVersion?: number
          focusBlockId?: string | null
          updatedSlug?: string
          appliedCount?: number
          restoredVersion?: number
          result?: AssistantResponse
        }
        try {
          payload = JSON.parse(event.data) as typeof payload
        } catch {
          return
        }
        gotAnyEvent = true

        // Track sequence number for reconnect
        if (typeof payload._seq === "number" && payload._seq > lastSeq) {
          lastSeq = payload._seq
          persistStreamContext()
        }

        if (payload.type === "status") {
          const msg = payload.message ?? "Working..."
          const accepted = advanceStep(msg)
          if (accepted !== null) setStreamStatus(accepted)
        }

        if (payload.type === "image_progress") {
          setImageProgress({ percent: payload.percent ?? 0, stage: payload.stage ?? "" })
        }

        if (payload.type === "token") {
          const text = payload.text ?? ""
          if (text) {
            setStreamTokenCount((prev) => prev + text.length)
          }
        }

        if (payload.type === "field_draft") {
          const blockId = typeof payload.blockId === "string" ? payload.blockId : ""
          const editablePath = typeof payload.editablePath === "string" ? payload.editablePath : ""
          const value = typeof payload.value === "string" ? payload.value : ""
          if (blockId && editablePath) {
            sawFieldDraftThisRun = true
            if (debugDraftEnabled) {
              const now = Date.now()
              const fieldKey = `${blockId}:${editablePath}`
              const prevLen = debugPrevValueLenByField.get(fieldKey) ?? 0
              const deltaChars = Math.max(1, Math.abs(value.length - prevLen))
              debugPrevValueLenByField.set(fieldKey, value.length)
              debugTotalFieldEvents += 1
              debugTotalFieldChars += deltaChars
              debugFieldEventAtMs.push(now)
              debugFieldCharAt.push({ at: now, chars: deltaChars })
              debugActiveTarget = fieldKey
              scheduleFieldDraftDebugFlush()
            }
            setLatestStreamFocusBlockId(blockId)
            beginOrUpdateLiveDraftTyping(blockId, editablePath, value)
          }
        }

        if (payload.type === "plan_meta") {
          setStreamingText(null)
          setStreamingChanges([])
          const estimatedOps = Number(payload.estimatedOps ?? 0)
          const planLabel = estimatedOps > 0
            ? `Plan ready (${estimatedOps} change${estimatedOps === 1 ? "" : "s"})`
            : "Plan ready"
          setStreamStatus(`${planLabel}...`)
          advanceStep(planLabel)
        }

        if (payload.type === "op_candidate") {
          const idx = Number(payload.index ?? 0)
          const candidateBlockId = blockIdFromOperation(payload.op)
          if (candidateBlockId) setLatestStreamFocusBlockId(candidateBlockId)
          if (!liveDraftBlockId) {
            if (candidateBlockId) {
              liveDraftBlockId = candidateBlockId
              if (liveDraftText.trim().length > 0) {
                liveDraftActive = true
                sendLiveDraft(true)
              }
            }
          }

          // Extract editable field values from operation for live typing
          // update_props → patch contains field values; add_block → block.props contains field values
          const op = payload.op
          if (op && typeof op === "object") {
            const opRecord = op as Record<string, unknown>
            const rawFields =
              (opRecord.patch && typeof opRecord.patch === "object" ? opRecord.patch :
               opRecord.block && typeof (opRecord.block as Record<string, unknown>).props === "object"
                 ? (opRecord.block as Record<string, unknown>).props : null) as Record<string, unknown> | null

            if (rawFields && !sawFieldDraftThisRun) {
              const fields: Record<string, string> = {}
              for (const [key, value] of Object.entries(rawFields)) {
                if (typeof value === "string" && value.trim()) {
                  fields[key] = value
                }
              }
              if (Object.keys(fields).length > 0) {
                liveDraftFields = fields
                if (liveDraftBlockId) {
                  liveDraftActive = true
                  sendLiveDraft(true)
                }
              }
            }

            // Send skeleton for add_block operations
            const opType = opRecord.op ?? opRecord.type
            if (opType === "add_block") {
              const blockObj = opRecord.block as Record<string, unknown> | undefined
              const afterBlockId = opRecord.afterBlockId
              postToSite("showSkeleton", {
                afterBlockId: typeof afterBlockId === "string" ? afterBlockId : null,
                blockType: typeof blockObj?.type === "string" ? blockObj.type : "Block"
              })
            }
          }

          setStreamStatus(idx > 0 ? `Drafting operation ${idx}...` : "Drafting operations...")
          const opLabel = labelFromOperation(payload.op)
          setOpChecklist((prev) => [...prev, { label: opLabel, done: false }])
        }

        if (payload.type === "heartbeat") {
          const elapsedSec = Math.max(0, Math.floor(Number(payload.elapsedMs ?? 0) / 1000))
          const label = String(payload.label ?? (payload.stage === "applying" ? "Applying" : "Planning"))
          setStreamStatus(`${label}… ${elapsedSec}s`)
        }

        if (payload.type === "summary_token") {
          setStreamingText((prev) => (prev ?? "") + (payload.text ?? ""))
        }
        if (payload.type === "changelog_entry") {
          const entry = (payload as { entry?: string }).entry ?? ""
          // Only show action-like entries (e.g. "Add Hero", "Update heading")
          // Filters out raw JSON keys and content values like "Key Features"
          const actionVerb = /^(add|update|set|remove|delete|create|change|replace|move|reorder|translate|fix|adjust|insert|duplicate|rename)/i
          if (entry.includes(" ") && entry.length > 3 && actionVerb.test(entry)) {
            setStreamingChanges((prev) => [...prev, entry])
          }
        }

        if (payload.type === "op_applied") {
          setStreamingText(null)
          setStreamingChanges([])
          if (liveDraftActive) {
            const typingInProgress =
              Boolean(liveDraftTypingTarget) && liveDraftTypingRendered !== liveDraftTypingDesired
            if (sawFieldDraftThisRun && typingInProgress) {
              deferEndLiveDraftUntilTypingSettles()
            } else {
              endLiveDraft(true)
            }
          }
          postToSite("removeSkeleton", {})
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          appliedOpCount += 1
          setOpChecklist((prev) => {
            const next = [...prev]
            const pending = next.findIndex((item) => !item.done)
            if (pending >= 0) next[pending] = { ...next[pending]!, done: true }
            return next
          })
          advanceStep(total > 0 ? `Applying changes (${appliedOpCount}/${total})` : "Applying changes")
          if (total > 0 && index > 0) {
            const suffix = skippedOpCount > 0 ? `, skipped ${skippedOpCount}` : ""
            setStreamStatus(`Applying changes (${index}/${total}, applied ${appliedOpCount}${suffix})...`)
          } else {
            const suffix = skippedOpCount > 0 ? `, skipped ${skippedOpCount}` : ""
            setStreamStatus(`Applying changes (applied ${appliedOpCount}${suffix})...`)
          }
          pendingFocusBlockId = typeof payload.focusBlockId === "string" ? payload.focusBlockId : null
          if (pendingFocusBlockId) setLatestStreamFocusBlockId(pendingFocusBlockId)
          lastOpAppliedAt = Date.now()
          lastOpTotal = total > 0 ? total : index > 0 ? index : lastOpTotal
          if (enablePatchTransport && payload.op && typeof payload.previewVersion === "number") {
            const toVersion = payload.previewVersion
            const fromVersion = toVersion - 1
            postPatchToSite(payload.op, fromVersion, toVersion, pendingFocusBlockId ?? undefined)
          } else if (total > 0 && index >= total) {
            clearOpRefreshTimer()
            flushOpRefresh()
          } else {
            scheduleOpRefresh()
          }

          // Navigate to a newly created page when the server signals updatedSlug
          if (typeof payload.updatedSlug === "string" && payload.updatedSlug.length > 0) {
            const nextSlug = payload.updatedSlug as string
            const slugChanged = nextSlug !== store.getState().slug
            if (slugChanged) {
              setSlug(nextSlug)
              store.getState().setActiveBlock(undefined, undefined)
              store.getState().setActiveEditablePath(undefined)
            }
            postToSite("draftUpdated", { focusBlockId: pendingFocusBlockId, navigateTo: slugChanged ? nextSlug : undefined })
            void refreshRouteSlugs()
          }
        }

        if (payload.type === "op_skipped") {
          skippedOpCount += 1
          setOpChecklist((prev) => {
            const next = [...prev]
            const pending = next.findIndex((item) => !item.done)
            if (pending >= 0) next[pending] = { ...next[pending]!, done: true }
            return next
          })
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          if (total > 0 && index > 0) {
            setStreamStatus(`Applying changes (${index}/${total}, applied ${appliedOpCount}, skipped ${skippedOpCount})...`)
          } else {
            setStreamStatus(`Applying changes (applied ${appliedOpCount}, skipped ${skippedOpCount})...`)
          }
        }

        if (payload.type === "rollback_started") {
          endLiveDraft()
          setStreamStatus("Rolling back partial changes...")
        }

        if (payload.type === "rollback_done") {
          setStreamStatus("Rollback complete. Syncing preview...")
          postToSite("draftUpdated", { focusBlockId: null })
        }

        if (payload.type === "final") {
          const completeFinal = () => {
            settled = true
            clearStreamContext()
            setStreamStatus(null)
            setStreamTokenCount(0)
            setImageProgress(null)
            setStreamingText(null)
            setStreamingChanges([])
            setStreamSteps([])
            setOpChecklist([])
            flushFieldDraftDebug()
            clearDebugFlushTimer()
            clearOpRefreshTimer()
            endLiveDraft()
            if (pendingFocusBlockId !== null) flushOpRefresh()
            if (payload.result) applyChatResult(payload.result)
            if (payload.result?.focusBlockId) setLatestStreamFocusBlockId(payload.result.focusBlockId)
            source.close()
            resolve(true)
          }

          const pendingTypedDraft =
            sawFieldDraftThisRun &&
            Boolean(liveDraftTypingTarget) &&
            liveDraftTypingRendered !== liveDraftTypingDesired
          if (pendingTypedDraft) {
            const waitStartedAt = Date.now()
            const maxWaitMs = 900
            const waitForTypedDraft = () => {
              const stillPending =
                Boolean(liveDraftTypingTarget) &&
                liveDraftTypingRendered !== liveDraftTypingDesired
              if (!stillPending || Date.now() - waitStartedAt >= maxWaitMs) {
                completeFinal()
                return
              }
              window.setTimeout(waitForTypedDraft, 16)
            }
            waitForTypedDraft()
            return
          }

          const elapsedSinceLastOp = lastOpAppliedAt > 0 ? Date.now() - lastOpAppliedAt : Number.POSITIVE_INFINITY
          const appliedTotal = lastOpTotal > 0 ? lastOpTotal : Number(payload.result?.debug?.opCount ?? 0)
          const minVisibleMs = appliedTotal <= 1 ? 100 : 250
          if (lastOpAppliedAt > 0 && elapsedSinceLastOp < minVisibleMs) {
            const skipped = Number(payload.result?.debug?.skippedOpCount ?? skippedOpCount ?? 0)
            const applied = Math.max(0, appliedTotal - skipped)
            if (appliedTotal > 0) {
              setStreamStatus(`Applied ${applied}/${appliedTotal}${skipped > 0 ? `, skipped ${skipped}` : ""}...`)
            } else {
              setStreamStatus("Applied changes...")
            }
            window.setTimeout(completeFinal, minVisibleMs - elapsedSinceLastOp)
          } else {
            completeFinal()
          }
        }

        if (payload.type === "canceled") {
          settled = true
          clearStreamContext()
          setStreamStatus(null)
          setStreamTokenCount(0)
          setImageProgress(null)
          setStreamingText(null)
          setStreamingChanges([])
          setStreamSteps([])
          setOpChecklist([])
          flushFieldDraftDebug()
          clearDebugFlushTimer()
          clearOpRefreshTimer()
          endLiveDraft()
          pendingFocusBlockId = null
          // Refresh preview to clear any image placeholders
          postToSite("draftUpdated", { focusBlockId: null })
          pushAssistantFromResult({ status: "info", summary: payload.message ?? "Request was canceled.", changes: [] })
          source.close()
          resolve(true)
        }

        if (payload.type === "error") {
          settled = true
          clearStreamContext()
          setStreamStatus(null)
          setStreamTokenCount(0)
          setImageProgress(null)
          setStreamingText(null)
          setStreamingChanges([])
          setStreamSteps([])
          setOpChecklist([])
          flushFieldDraftDebug()
          clearDebugFlushTimer()
          clearOpRefreshTimer()
          endLiveDraft()
          pendingFocusBlockId = null
          if (payload.result) {
            applyChatResult(payload.result)
          } else {
            pushAssistantFromResult({ status: "error", summary: t("streamError.failed"), changes: [] })
          }
          source.close()
          resolve(true)
        }
      }

      source.onerror = () => {
        if (settled) {
          source.close()
          return
        }

        // If we got events, attempt reconnect with afterSeq
        if (gotAnyEvent && lastSeq > 0) {
          source.close()
          setStreamStatus("Reconnecting...")
          const reconnectSource = new EventSource(
            withAccessTokenQuery(`${orchestrator}/chat/stream?streamId=${streamId}&afterSeq=${lastSeq}`)
          )
          reconnectSource.onmessage = source.onmessage
          reconnectSource.onerror = () => {
            // Reconnect failed — resolve as success since we got partial events
            clearStreamContext()
            setStreamStatus(null)
            setStreamTokenCount(0)
            setStreamingText(null)
            setStreamingChanges([])
            setStreamSteps([])
            setOpChecklist([])
            flushFieldDraftDebug()
            clearDebugFlushTimer()
            clearOpRefreshTimer()
            endLiveDraft()
            if (pendingFocusBlockId !== null) flushOpRefresh()
            pendingFocusBlockId = null
            settled = true
            reconnectSource.close()
            resolve(true)
          }
          return
        }

        if (gotAnyEvent) {
          clearStreamContext()
          setStreamStatus(null)
          setStreamTokenCount(0)
          setStreamingText(null)
          setStreamingChanges([])
          setStreamSteps([])
          setOpChecklist([])
          flushFieldDraftDebug()
          clearDebugFlushTimer()
          clearOpRefreshTimer()
          endLiveDraft()
          if (pendingFocusBlockId !== null) flushOpRefresh()
          pendingFocusBlockId = null
          source.close()
          resolve(true)
          return
        }
        clearStreamContext()
        setStreamStatus(t("streamError.retrying"))
        setStreamTokenCount(0)
        setStreamingText(null)
        setStreamingChanges([])
        flushFieldDraftDebug()
        clearDebugFlushTimer()
        clearOpRefreshTimer()
        endLiveDraft()
        pendingFocusBlockId = null
        settled = true
        source.close()
        resolve(false)
      }
    })
  }

  async function cancelChat() {
    // Cancel agent mode if active
    if (agentCancelRef.current) {
      agentCancelRef.current()
      agentCancelRef.current = null
      setIsLoading(false)
      setStreamStatus(null)
      setStreamSteps([])
      setOpChecklist([])
      return
    }

    const currentStreamId = activeStreamIdRef.current
    if (!currentStreamId) return
    setStreamStatus(t("streamError.canceling"))
    try {
      const res = await fetch(`${orchestrator}/chat/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ streamId: currentStreamId })
      })
      if (res.ok) {
        const data = await res.json() as { status?: string }
        if (data.status === "not_found" || data.status === "already_terminal") {
          // Nothing to cancel — let the stream finish naturally
          return
        }
      }
    } catch {
      // Best-effort cancel
    }
  }

  // --- Compose sub-hooks (slim deps — most state from store/singleton) ---

  const structuralOps = useStructuralOps({
    postToSite,
    postPatchToSite,
    activeSiteConfig,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
  })

  const variations = useVariations({
    postToSite,
    postPatchToSite,
    activeSiteConfig,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
  })

  const planApproval = usePlanApproval({
    submitChatStream,
    submitChatHttp
  })

  const undoHistory = useUndoHistory({
    postToSite,
    postPatchToSite,
    refreshRouteSlugs
  })

  async function continueChain(chainId: string) {
    if (!chainId || store.getState().isLoading) return
    store.getState().appendChatEntry({ id: createId(), role: "user", text: t("ops.continueNext") })
    setIsLoading(true)
    try {
      await submitChatHttp("Continue to next step", {
        executionMode: "continue_chain",
        continuationChainId: chainId
      })
    } catch (error) {
      pushAssistantFromResult({
        status: "error",
        summary: `Continuation failed: ${error instanceof Error ? error.message : "unknown error"}`,
        changes: []
      })
    } finally {
      setStreamingText(null)
      setStreamingChanges([])
      setIsLoading(false)
    }
  }

  async function submitChat(explicitMessage?: string, currentMessage?: string) {
    const finalMessage = (explicitMessage ?? currentMessage ?? "").trim()
    if (!finalMessage || store.getState().isLoading) return

    // If there's a pending plan and the user types an approval-like message,
    // route through the plan approval flow instead of treating as a new request.
    const { pendingPlanId, useStreaming } = store.getState()
    if (pendingPlanId && /\b(approve|execute|go\s+ahead|yes|do\s+it|apply|confirm)\b/i.test(finalMessage)) {
      await planApproval.approvePendingPlan(pendingPlanId)
      return
    }

    lastSentMessageRef.current = finalMessage
    store.getState().appendChatEntry({ id: createId(), role: "user", text: finalMessage })
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Thinking..." : null)
    setOpChecklist([])
    setStreamTokenCount(0)
    setFieldDraftDebug({
      eventsPerSecond: 0,
      charsPerSecond: 0,
      totalEvents: 0,
      totalChars: 0,
      typingLagChars: 0,
      activeTarget: null
    })
    setLatestStreamFocusBlockId(null)
    try {
      if (isVariationRequest(finalMessage)) {
        await variations.submitVariations(finalMessage)
        return
      }
      // Agent mode: when server has AGENT_API_KEY configured
      if (config.agentModeEnabled) {
        const { slug: agentSlug, activeBlockId: agentBlockId, activeBlockType: agentBlockType, activeEditablePath: agentEditablePath } = store.getState()
        const handle = submitAgentStream({
          orchestrator,
          session,
          siteId,
          slug: agentSlug,
          message: finalMessage,
          activeBlockId: agentBlockId,
          activeBlockType: agentBlockType,
          activeEditablePath: agentEditablePath,
          locale,
          sitePurpose: activeSiteConfig.purpose,
          setStreamStatus,
          setStreamSteps,
          setOpChecklist,
          labelFromOperation,
          setStreamingText,
          setStreamingChanges,
          setLatestStreamFocusBlockId,
          applyChatResult,
          pushAssistantFromResult,
          postToSite,
          setActiveBlockId: (id: string | undefined) => store.getState().setActiveBlock(id),
        })
        agentCancelRef.current = handle.cancel
        const ok = await handle.promise
        agentCancelRef.current = null
        if (!ok) {
          pushAssistantFromResult({ status: "error", summary: "Agent failed. Check AGENT_API_KEY in the orchestrator .env.", changes: [] })
        }
        return
      }

      const requiresPlanApproval = isComplexTaskRequest(finalMessage)
      if (requiresPlanApproval) {
        planApproval.setPendingPlanMessage(finalMessage)
        const planOnlyParams = { executionMode: "plan_only" as const }
        if (useStreaming) {
          const ok = await submitChatStream(finalMessage, planOnlyParams)
          if (!ok) await submitChatHttp(finalMessage, planOnlyParams)
        } else {
          await submitChatHttp(finalMessage, planOnlyParams)
        }
        return
      }
      if (useStreaming) {
        const ok = await submitChatStream(finalMessage)
        if (!ok) await submitChatHttp(finalMessage)
      } else {
        await submitChatHttp(finalMessage)
      }
    } finally {
      setStreamStatus(null)
      setStreamingText(null)
      setStreamingChanges([])
      setStreamSteps([])
      setOpChecklist([])
      setIsLoading(false)
    }
  }

  async function submitFeedback(entryId: string, rating: "up" | "down", note?: string) {
    const entry = store.getState().chatLog.find((e) => e.id === entryId)
    if (!entry?.debug?.traceId) return
    try {
      await fetch(`${orchestrator}/telemetry/chat/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId: entry.debug.traceId, session, rating, note })
      })
    } catch { /* best-effort */ }
    store.getState().setChatLog((prev) =>
      prev.map((e) => e.id === entryId ? { ...e, feedback: { rating, note, at: new Date().toISOString() } } : e)
    )
  }

  // State is now read from the store via selectors in components.
  // This hook returns only action functions + the few remaining local values.
  return {
    // Actions (the primary API for components)
    submitChat,
    cancelChat,
    applyVariation: variations.applyVariation,
    approvePendingPlan: planApproval.approvePendingPlan,
    stopPendingPlan: planApproval.stopPendingPlan,
    continueChain,
    applyUndoHistory: undoHistory.applyUndoHistory,
    applyGlobalUndo: undoHistory.applyGlobalUndo,
    applyGlobalRedo: undoHistory.applyGlobalRedo,
    refreshRouteSlugs,
    syncFromSite,
    addBlockAfter: structuralOps.addBlockAfter,
    addListItem: structuralOps.addListItem,
    removeListItem: structuralOps.removeListItem,
    moveListItem: structuralOps.moveListItem,
    reorderBlock: structuralOps.reorderBlock,
    deleteBlock: structuralOps.deleteBlock,
    inlineEditCommit: structuralOps.inlineEditCommit,
    clearFieldAiContext: () => store.getState().setChatLog((prev) => prev.filter((e) => !e.fieldAiContext)),
    setFieldAiContext: (entry: ChatEntry) => store.getState().setChatLog((prev) => [...prev.filter((e) => !e.fieldAiContext), entry]),
    clearChat: () => store.getState().setChatLog([buildWelcomeEntry()]),
    submitFeedback,
    submitVariations: variations.submitVariations,
    hasBootstrapped,

    // Legacy pass-through — components migrating to store selectors
    // can still read these until fully migrated.
    undoInFlightEntryId: undoHistory.undoInFlightEntryId,
    canUndoServer: undoHistory.canUndoServer,
    canRedoServer: undoHistory.canRedoServer,
    setCanUndoServer: undoHistory.setCanUndoServer,
    setCanRedoServer: undoHistory.setCanRedoServer,
    refreshHistoryStatus: undoHistory.refreshHistoryStatus,
    pushAssistantFromResult,
  }
}
