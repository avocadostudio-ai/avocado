import { useEffect, useRef, useState } from "react"
import {
  type EditorComponentsManifest,
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
  componentManifest?: EditorComponentsManifest | null
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

  // Track last sent message so server-forced plan_only can populate pendingPlanMessage
  const lastSentMessageRef = useRef<string | null>(null)
  const activeStreamIdRef = useRef<string | null>(null)

  // Use refs for values accessed in closures to avoid stale captures
  const slugRef = useRef(slug)
  slugRef.current = slug
  const routeOptionsRef = useRef(routeOptions)
  routeOptionsRef.current = routeOptions

  function pushAssistantFromResult(data: AssistantResponse, options?: { canUndo?: boolean }) {
    const errors = normalizeValidationErrors(data.validationErrors)
    const parsedChanges = splitAiInsightChanges(data.changes)
    const entry: ChatEntry = {
      id: createId(),
      role: "assistant",
      text: data.summary ?? data.error ?? "Request failed.",
      status: data.status,
      canUndo: options?.canUndo ?? false,
      wasUndone: false,
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
    if (data.continuation?.chainId) {
      setContinuationChainId(data.continuation.chainId)
    } else {
      setContinuationChainId(null)
    }
    pushAssistantFromResult(data, { canUndo: data.status === "applied" })
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
      if (list.length > 0) {
        setAvailableSlugs(list)
        return list
      }

      // Auto-bootstrap for new site namespaces with no draft pages.
      try {
        const bootstrapSourceRes = await fetch(`${activeSiteOrigin}/api/editor/bootstrap-pages?siteId=${encodeURIComponent(siteId)}`)
        if (bootstrapSourceRes.ok) {
          const bootstrapSource = (await bootstrapSourceRes.json()) as { pages?: unknown }
          if (Array.isArray(bootstrapSource.pages) && bootstrapSource.pages.length > 0) {
            await fetch(`${orchestrator}/draft/bootstrap`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                session,
                siteId,
                pages: bootstrapSource.pages,
                overwrite: false
              })
            })
            const second = await fetch(slugsUrl)
            if (second.ok) {
              const secondData = (await second.json()) as { slugs?: unknown }
              const secondList = Array.isArray(secondData.slugs)
                ? secondData.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
                : []
              if (secondList.length > 0) {
                setAvailableSlugs(secondList)
                return secondList
              }
            }
          }
        }
      } catch {
        // Keep fallback route options when bootstrap is unavailable.
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
      let liveDraftActive = false
      let liveDraftFields: Record<string, string> | null = null
      let currentStepLabel: string | null = null

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

      const endLiveDraft = () => {
        clearLiveDraftTimer()
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
          type: "status" | "token" | "plan_meta" | "op_candidate" | "op_applied" | "op_skipped" | "heartbeat" | "rollback_started" | "rollback_done" | "final" | "error" | "canceled" | "summary_token" | "changelog_entry" | "image_progress"
          _seq?: number
          message?: string
          text?: string
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
            if (liveDraftBlockId) {
              liveDraftText += text
              liveDraftActive = true
              scheduleLiveDraftFlush()
            }
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
          if (!liveDraftBlockId) {
            const derived = blockIdFromOperation(payload.op)
            if (derived) {
              liveDraftBlockId = derived
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

            if (rawFields) {
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
          setStreamingChanges((prev) => [...prev, (payload as { entry?: string }).entry ?? ""])
        }

        if (payload.type === "op_applied") {
          setStreamingText(null)
          setStreamingChanges([])
          if (liveDraftActive) endLiveDraft()
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
            clearOpRefreshTimer()
            endLiveDraft()
            if (pendingFocusBlockId !== null) flushOpRefresh()
            if (payload.result) applyChatResult(payload.result)
            if (payload.result?.focusBlockId) setLatestStreamFocusBlockId(payload.result.focusBlockId)
            source.close()
            resolve(true)
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
    postToSite,
    setChatLog,
    pushAssistantFromResult
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
    setStreamStatus(useStreaming ? "Connecting..." : null)
    setStreamTokenCount(0)
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
