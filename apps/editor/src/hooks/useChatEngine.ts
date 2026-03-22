import { useEffect, useRef, useState } from "react"
import {
  type BlockManifest,
  type Operation
} from "@ai-site-editor/shared"
import type {
  AIProvider,
  AssistantResponse,
  ChatEntry,
  ChatExecutionMode,
  ModelKey,
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
import { parseString } from "../lib/parse-utils"
import { usePlanApproval } from "./chat-engine/usePlanApproval"
import { useStructuralOps } from "./chat-engine/useStructuralOps"
import { useUndoHistory } from "./chat-engine/useUndoHistory"
import { useVariations } from "./chat-engine/useVariations"

export type ChatEngineConfig = {
  session: string
  siteId: string
  activeSiteConfig: SiteConfig
  slug: string
  setSlug: (slug: string) => void
  modelKey: ModelKey
  provider: AIProvider
  useStreaming: boolean
  activeBlockIdRef: React.RefObject<string | undefined>
  activeBlockTypeRef: React.RefObject<string | undefined>
  activeEditablePathRef: React.RefObject<string | undefined>
  setActiveBlockId: (id: string | undefined) => void
  setActiveBlockType: (type: string | undefined) => void
  setActiveEditablePath: (path: string | undefined) => void
  postToSite: (type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading", payload: Record<string, unknown>) => void
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
  setAvailableSlugs: (slugs: string[]) => void
  setIsLoadingSlugs: (loading: boolean) => void
  routeOptions: string[]
  componentManifest?: BlockManifest | null
  siteCapabilities?: SiteCapabilities
  allowStructuralEdits: boolean
  getBlockDefaultProps?: (blockType: string) => Record<string, unknown> | null
  onApplied?: () => void
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
    postToSite,
    postPatchToSite,
    setAvailableSlugs,
    setIsLoadingSlugs,
    routeOptions,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
    onApplied
  } = config

  const activeSiteOrigin = resolveSiteOrigin(activeSiteConfig)
  const chatLogStorageKey = `editor-chat-log-v1:${session}:${siteId}`

  const blockIdFromOperation = (op?: Operation) => {
    if (!op || typeof op !== "object") return null
    if ("blockId" in op && typeof op.blockId === "string" && op.blockId.length > 0) return op.blockId
    if (op.op === "add_block" && op.block && typeof op.block.id === "string" && op.block.id.length > 0) return op.block.id
    if (op.op === "duplicate_block" && typeof op.newBlockId === "string" && op.newBlockId.length > 0) return op.newBlockId
    return null
  }

  const welcomeEntry: ChatEntry = {
    id: "welcome",
    role: "assistant",
    text: "Let's shape your site into something people remember. I can add sections, rewrite copy, rearrange blocks, create new pages, and more. Click anything in the preview or tell me the result you want.",
    suggestions: [
      "Add testimonials below hero",
      "Change the hero headline",
      "Create a new /about page",
      "Add a FAQ section"
    ]
  }

  const [chatLog, setChatLog] = useState<ChatEntry[]>(() => {
    try {
      const stored = localStorage.getItem(chatLogStorageKey)
      if (stored) {
        const parsed = JSON.parse(stored) as ChatEntry[]
        if (Array.isArray(parsed) && parsed.length > 0) return parsed
      }
    } catch { /* ignore corrupt data */ }
    return [welcomeEntry]
  })

  useEffect(() => {
    try {
      const toStore = chatLog.slice(-50).map(({ status, ...rest }) => rest)
      localStorage.setItem(chatLogStorageKey, JSON.stringify(toStore))
    } catch { /* ignore quota errors */ }
  }, [chatLog, chatLogStorageKey])
  const [isLoading, setIsLoading] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamTokenCount, setStreamTokenCount] = useState(0)
  const [imageProgress, setImageProgress] = useState<{ percent: number; stage: string } | null>(null)
  const [latestStreamFocusBlockId, setLatestStreamFocusBlockId] = useState<string | null>(null)
  const [continuationChainId, setContinuationChainId] = useState<string | null>(null)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamingChanges, setStreamingChanges] = useState<string[]>([])
  const [streamSteps, setStreamSteps] = useState<{ label: string; done: boolean }[]>([])
  const [fieldDraftDebugEnabled, setFieldDraftDebugEnabled] = useState(false)
  const [fieldDraftDebug, setFieldDraftDebug] = useState<{
    eventsPerSecond: number
    charsPerSecond: number
    totalEvents: number
    totalChars: number
    typingLagChars: number
    activeTarget: string | null
  }>({
    eventsPerSecond: 0,
    charsPerSecond: 0,
    totalEvents: 0,
    totalChars: 0,
    typingLagChars: 0,
    activeTarget: null
  })

  // Track last sent message so server-forced plan_only can populate pendingPlanMessage
  const lastSentMessageRef = useRef<string | null>(null)
  const activeStreamIdRef = useRef<string | null>(null)

  // Use refs for values accessed in closures to avoid stale captures
  const slugRef = useRef(slug)
  slugRef.current = slug
  const routeOptionsRef = useRef(routeOptions)
  routeOptionsRef.current = routeOptions

  function pushAssistantFromResult(data: AssistantResponse, options?: { canUndo?: boolean; undoSlug?: string }) {
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
      mentionedSlugs: Array.isArray(data.mentionedSlugs) ? data.mentionedSlugs.filter((s): s is string => typeof s === "string") : [],
      suggestions: data.suggestions ?? [],
      errors,
      meta: data.modelUsed ? `${data.modelUsed}${data.modelKey ? ` (${data.modelKey})` : ""}` : undefined,
      debug: data.debug,
      aiJustification: parsedChanges.aiJustification,
      aiPerformanceNote: parsedChanges.aiPerformanceNote,
      pendingPlanId: typeof data.pendingPlanId === "string" ? data.pendingPlanId : undefined,
      continuation: data.continuation ?? undefined
    }

    setChatLog((prev) => {
      if (!entry.canUndo) return [...prev, entry]
      const withoutUndo = prev.map((row) => (row.canUndo ? { ...row, canUndo: false, wasUndone: false } : row))
      return [...withoutUndo, entry]
    })
  }

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource === "openai" || data.plannerSource === "anthropic" || data.plannerSource === "demo") {
      planApproval.setPlannerBadgeState(data.plannerSource)
    }
    if (data.status === "plan_ready" && typeof data.pendingPlanId === "string" && data.pendingPlanId.length > 0) {
      planApproval.setPendingPlanId(data.pendingPlanId)
      // Server may force plan_only (e.g. for image generation) on a non-complex message.
      // Ensure pendingPlanMessage is populated so approval sends the original text.
      planApproval.setPendingPlanMessage((prev) => prev ?? lastSentMessageRef.current)
    } else if (data.status === "applied" || data.status === "canceled") {
      planApproval.setPendingPlanId(null)
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
    const undoSlug = typeof data.undoSlug === "string" && data.undoSlug.length > 0
      ? data.undoSlug
      : slugRef.current
    pushAssistantFromResult(data, { canUndo: data.status === "applied", undoSlug })
    if (data.status === "applied") {
      const currentSlug = slugRef.current
      const nextSlug = parseString(data.updatedSlug, currentSlug)
      if (nextSlug !== currentSlug) {
        setSlug(nextSlug)
        activeBlockIdRef.current = undefined
        activeBlockTypeRef.current = undefined
        activeEditablePathRef.current = undefined
        setActiveBlockId(undefined)
        setActiveBlockType(undefined)
        setActiveEditablePath(undefined)
      }
      postToSite("draftUpdated", { focusBlockId: data.focusBlockId ?? null })
      if (data.focusBlockId) {
        activeBlockIdRef.current = data.focusBlockId
        setActiveBlockId(data.focusBlockId)
      }
      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      void refreshRouteSlugs()
      onApplied?.()
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

  async function refreshRouteSlugs() {
    setIsLoadingSlugs(true)
    try {
      const slugsUrl = `${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
      const res = await fetch(slugsUrl)
      if (!res.ok) return routeOptionsRef.current
      const data = (await res.json()) as { slugs?: unknown }
      const list = Array.isArray(data.slugs)
        ? data.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []

      // On first load for this session, always sync from the site to pick up CMS changes
      if (!hasBootstrappedRef.current) {
        hasBootstrappedRef.current = true
        const bootstrapResult = await bootstrapFromSite()
        if (bootstrapResult.synced && bootstrapResult.slugs.length > 0) {
          setAvailableSlugs(bootstrapResult.slugs)
          return bootstrapResult.slugs
        }
      }

      if (list.length > 0) {
        setAvailableSlugs(list)
        return list
      }

      return routeOptionsRef.current
    } catch {
      return routeOptionsRef.current
    } finally {
      setIsLoadingSlugs(false)
    }
  }

  async function submitChatHttp(finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string; continuationChainId?: string }) {
    const contextPayload = buildSiteContextPayload(siteId, activeSiteConfig)
    const res = await fetch(`${orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
        session,
        siteId,
        ...contextPayload,
        slug: slugRef.current,
        message: finalMessage,
        modelKey,
        provider,
        activeBlockId: activeBlockIdRef.current,
        activeBlockType: activeBlockTypeRef.current,
        activeEditablePath: activeEditablePathRef.current,
        executionMode: options?.executionMode ?? "auto",
        pendingPlanId: options?.pendingPlanId,
        ...(options?.continuationChainId ? { continuationChainId: options.continuationChainId } : {})
      }, componentManifest, siteCapabilities))
    })

    const data = (await res.json()) as AssistantResponse
    applyChatResult(data)
  }

  async function submitChatStream(finalMessage: string, extraParams?: Record<string, string>) {
    const contextPayload = buildSiteContextPayload(siteId, activeSiteConfig)
    const payload = withIntegrationContext({
      session,
      siteId,
      ...contextPayload,
      slug: slugRef.current,
      message: finalMessage,
      modelKey,
      provider,
      activeBlockId: activeBlockIdRef.current,
      activeBlockType: activeBlockTypeRef.current,
      activeEditablePath: activeEditablePathRef.current,
      ...(extraParams ?? {})
    }, componentManifest, siteCapabilities)

    // Show immediate feedback before any SSE events arrive
    setStreamStatus("Thinking...")

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

      const source = new EventSource(`${orchestrator}/chat/stream?streamId=${streamId}`)
      let settled = false
      let gotAnyEvent = false
      let pendingFocusBlockId: string | null = null
      let opRefreshTimer: number | null = null
      let lastOpAppliedAt = 0
      let lastOpTotal = 0
      let appliedOpCount = 0
      let skippedOpCount = 0
      let liveDraftBlockId: string | null = activeBlockIdRef.current ?? null
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
      const debugDraftEnabled = fieldDraftDebugEnabled
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
      const advanceStep = (label: string) => {
        const baseLabel = normalizeStepLabel(label)
        const prevBase = currentStepLabel ? normalizeStepLabel(currentStepLabel) : null
        if (baseLabel === prevBase) {
          // Same phase — update the display label in-place (e.g. "Applying changes (3/8)")
          currentStepLabel = label
          const display = label.replace(/[\u2026.]+$/, "").trim()
          setStreamSteps((prev) => {
            if (prev.length === 0) return prev
            const last = prev[prev.length - 1]
            if (last.done || last.label === display) return prev
            return [...prev.slice(0, -1), { ...last, label: display }]
          })
          return
        }
        currentStepLabel = label
        const display = label.replace(/[\u2026.]+$/, "").trim()
        setStreamSteps((prev) => {
          const next = prev.map((s) => (s.done ? s : { ...s, done: true }))
          next.push({ label: display, done: false })
          return next
        })
      }

      const sendLiveDraft = (force = false) => {
        if (!liveDraftBlockId) return
        if (!force && !liveDraftActive) return
        postToSite("liveDraft", {
          blockId: liveDraftBlockId,
          text: liveDraftText.slice(0, 2400),
          active: liveDraftActive,
          ...(liveDraftFields ? { fields: liveDraftFields } : {})
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
              endLiveDraft()
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

      const endLiveDraft = () => {
        clearLiveDraftTimer()
        resetLiveDraftTyping()
        if (!liveDraftBlockId && !liveDraftActive) return
        liveDraftActive = false
        sendLiveDraft(true)
        liveDraftText = ""
        liveDraftFields = null
      }

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
          setStreamStatus(msg)
          advanceStep(msg)
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
              endLiveDraft()
            }
          }
          postToSite("removeSkeleton", {})
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          appliedOpCount += 1
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
            if (nextSlug !== slugRef.current) {
              setSlug(nextSlug)
              activeBlockIdRef.current = undefined
              activeBlockTypeRef.current = undefined
              activeEditablePathRef.current = undefined
              setActiveBlockId(undefined)
              setActiveBlockType(undefined)
              setActiveEditablePath(undefined)
            }
            postToSite("draftUpdated", { focusBlockId: pendingFocusBlockId })
            void refreshRouteSlugs()
          }
        }

        if (payload.type === "op_skipped") {
          skippedOpCount += 1
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
          flushFieldDraftDebug()
          clearDebugFlushTimer()
          clearOpRefreshTimer()
          endLiveDraft()
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
        if (settled) {
          source.close()
          return
        }

        // If we got events, attempt reconnect with afterSeq
        if (gotAnyEvent && lastSeq > 0) {
          source.close()
          setStreamStatus("Reconnecting...")
          const reconnectSource = new EventSource(
            `${orchestrator}/chat/stream?streamId=${streamId}&afterSeq=${lastSeq}`
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
        setStreamStatus("Streaming failed, retrying with standard request...")
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
    const currentStreamId = activeStreamIdRef.current
    if (!currentStreamId) return
    setStreamStatus("Canceling...")
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

  // --- Compose sub-hooks ---

  const structuralOps = useStructuralOps({
    session,
    siteId,
    activeSiteConfig,
    slug,
    setSlug,
    activeBlockIdRef,
    activeBlockTypeRef,
    activeEditablePathRef,
    setActiveBlockId,
    setActiveBlockType,
    setActiveEditablePath,
    postToSite,
    postPatchToSite,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
    pushAssistantFromResult
  })

  const variations = useVariations({
    session,
    siteId,
    activeSiteConfig,
    slug,
    setSlug,
    activeBlockIdRef,
    activeBlockTypeRef,
    activeEditablePathRef,
    setActiveBlockId,
    setActiveBlockType,
    setActiveEditablePath,
    postToSite,
    postPatchToSite,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
    pushAssistantFromResult,
    slugRef,
    modelKey,
    provider
  })

  const planApproval = usePlanApproval({
    isLoading,
    setIsLoading,
    useStreaming,
    setChatLog,
    setLatestStreamFocusBlockId,
    setStreamStatus,
    setStreamingText,
    setStreamingChanges,
    setStreamSteps,
    pushAssistantFromResult,
    submitChatStream,
    submitChatHttp
  })

  const undoHistory = useUndoHistory({
    session,
    siteId,
    slugRef,
    isLoading,
    activeEditablePathRef,
    setActiveEditablePath,
    setSlug,
    postToSite,
    setChatLog,
    pushAssistantFromResult,
    refreshRouteSlugs
  })

  async function continueChain(chainId: string) {
    if (!chainId || isLoading) return
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Continue to next step." }])
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
    if (!finalMessage || isLoading) return

    // If there's a pending plan and the user types an approval-like message,
    // route through the plan approval flow instead of treating as a new request.
    if (planApproval.pendingPlanId && /\b(approve|execute|go\s+ahead|yes|do\s+it|apply|confirm)\b/i.test(finalMessage)) {
      await planApproval.approvePendingPlan(planApproval.pendingPlanId)
      return
    }

    lastSentMessageRef.current = finalMessage
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: finalMessage }])
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Thinking..." : null)
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
      setIsLoading(false)
    }
  }

  return {
    chatLog,
    isLoading,
    streamStatus,
    streamTokenCount,
    fieldDraftDebugEnabled,
    setFieldDraftDebugEnabled,
    fieldDraftDebug,
    imageProgress,
    streamingText,
    streamingChanges,
    streamSteps,
    latestStreamFocusBlockId,
    plannerBadgeState: planApproval.plannerBadgeState,
    setPlannerBadgeState: planApproval.setPlannerBadgeState,
    pendingPlanId: planApproval.pendingPlanId,
    variationModal: variations.variationModal,
    setVariationModal: variations.setVariationModal,
    isApplyingVariation: variations.isApplyingVariation,
    undoInFlightEntryId: undoHistory.undoInFlightEntryId,
    pushAssistantFromResult,
    submitChat,
    cancelChat,
    applyVariation: variations.applyVariation,
    approvePendingPlan: planApproval.approvePendingPlan,
    stopPendingPlan: planApproval.stopPendingPlan,
    continueChain,
    continuationChainId,
    applyUndoHistory: undoHistory.applyUndoHistory,
    refreshRouteSlugs,
    syncFromSite,
    addBlockAfter: structuralOps.addBlockAfter,
    addListItem: structuralOps.addListItem,
    removeListItem: structuralOps.removeListItem,
    moveListItem: structuralOps.moveListItem,
    reorderBlock: structuralOps.reorderBlock,
    deleteBlock: structuralOps.deleteBlock,
    inlineEditCommit: structuralOps.inlineEditCommit,
    clearFieldAiContext: () => setChatLog((prev) => prev.filter((e) => !e.fieldAiContext)),
    setFieldAiContext: (entry: ChatEntry) => setChatLog((prev) => [...prev.filter((e) => !e.fieldAiContext), entry]),
    clearChat: () => setChatLog([welcomeEntry])
  }
}
