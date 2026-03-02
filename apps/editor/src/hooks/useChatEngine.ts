import { useRef, useState } from "react"
import type { Operation } from "@ai-site-editor/shared"
import type {
  AIProvider,
  ApplyOpsResponse,
  AssistantResponse,
  ChatEntry,
  ChatExecutionMode,
  HistoryResponse,
  ModelKey,
  PlannerBadgeState,
  PlannerSource,
  SiteConfig,
  VariationModalState,
  VariationOption,
  VariationResponse
} from "../lib/editor-types"
import {
  createId,
  enablePatchTransport,
  isComplexTaskRequest,
  isVariationRequest,
  orchestrator,
  splitAiInsightChanges
} from "../lib/editor-utils"

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
  postToSite: (type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility", payload: Record<string, unknown>) => void
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
  setAvailableSlugs: (slugs: string[]) => void
  setIsLoadingSlugs: (loading: boolean) => void
  routeOptions: string[]
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
    routeOptions
  } = config

  const [chatLog, setChatLog] = useState<ChatEntry[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "I can add sections, edit text, rearrange blocks, create new pages, and more. Click anything in the preview or describe what you'd like to change.",
      suggestions: [
        "Add testimonials below hero",
        "Change the hero headline",
        "Create a new /about page",
        "Add a FAQ section"
      ]
    }
  ])
  const [isLoading, setIsLoading] = useState(false)
  const [streamStatus, setStreamStatus] = useState<string | null>(null)
  const [streamTokenCount, setStreamTokenCount] = useState(0)
  const [plannerBadgeState, setPlannerBadgeState] = useState<PlannerBadgeState>("checking")
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(null)
  const [pendingPlanMessage, setPendingPlanMessage] = useState<string | null>(null)
  const [variationModal, setVariationModal] = useState<VariationModalState | null>(null)
  const [isApplyingVariation, setIsApplyingVariation] = useState(false)
  const [undoInFlightEntryId, setUndoInFlightEntryId] = useState<string | null>(null)

  // Track last sent message so server-forced plan_only can populate pendingPlanMessage
  const lastSentMessageRef = useRef<string | null>(null)

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
      pendingPlanId: typeof data.pendingPlanId === "string" ? data.pendingPlanId : undefined
    }

    setChatLog((prev) => {
      if (!entry.canUndo) return [...prev, entry]
      const withoutUndo = prev.map((row) => (row.canUndo ? { ...row, canUndo: false, wasUndone: false } : row))
      return [...withoutUndo, entry]
    })
  }

  function applyChatResult(data: AssistantResponse) {
    if (data.plannerSource === "openai" || data.plannerSource === "anthropic" || data.plannerSource === "demo") {
      setPlannerBadgeState(data.plannerSource)
    }
    if (data.status === "plan_ready" && typeof data.pendingPlanId === "string" && data.pendingPlanId.length > 0) {
      setPendingPlanId(data.pendingPlanId)
      // Server may force plan_only (e.g. for image generation) on a non-complex message.
      // Ensure pendingPlanMessage is populated so approval sends the original text.
      setPendingPlanMessage((prev) => prev ?? lastSentMessageRef.current)
    } else if (data.status === "applied" || data.status === "canceled") {
      setPendingPlanId(null)
      setPendingPlanMessage(null)
    }
    pushAssistantFromResult(data, { canUndo: data.status === "applied" })
    if (data.status === "applied") {
      const currentSlug = slugRef.current
      const nextSlug = typeof data.updatedSlug === "string" && data.updatedSlug.length > 0 ? data.updatedSlug : currentSlug
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
    }
  }

  async function refreshRouteSlugs() {
    setIsLoadingSlugs(true)
    try {
      const res = await fetch(`${orchestrator}/draft/slugs?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`)
      if (!res.ok) return routeOptionsRef.current
      const data = (await res.json()) as { slugs?: unknown }
      const list = Array.isArray(data.slugs)
        ? data.slugs.filter((item): item is string => typeof item === "string" && item.length > 0)
        : []
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

  async function reorderBlock(slugForOp: string, blockId: string, afterBlockId?: string) {
    if (!blockId) return
    const op: Record<string, unknown> = { op: "move_block", pageSlug: slugForOp, blockId }
    if (afterBlockId) op.afterBlockId = afterBlockId

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, ops: [op] })
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
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "move_block" as const, pageSlug: slugForOp, blockId, ...(afterBlockId ? { afterBlockId } : {}) }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
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
        body: JSON.stringify({ session, siteId, ops: [op] })
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
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "remove_block" as const, pageSlug: slugForOp, blockId }
        postPatchToSite(typedOp, fromVersion, toVersion)
      } else {
        postToSite("draftUpdated", { focusBlockId: null })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not delete block.",
        changes: []
      })
    }
  }

  async function inlineEditCommit(slugForOp: string, blockId: string, editablePath: string, value: string) {
    if (!blockId || !editablePath) return

    const indexedPath = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(editablePath)
    let op: Record<string, unknown> | null = null

    if (indexedPath) {
      const listKey = indexedPath[1]
      const index = Number(indexedPath[2])
      const fieldKey = indexedPath[3]
      op = {
        op: "update_item",
        pageSlug: slugForOp,
        blockId,
        listKey,
        index,
        patch: { [fieldKey]: value }
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(editablePath)) {
      op = {
        op: "update_props",
        pageSlug: slugForOp,
        blockId,
        patch: { [editablePath]: value }
      }
    }

    if (!op) {
      pushAssistantFromResult({
        status: "error",
        summary: `Inline edit is not supported for "${editablePath}".`,
        changes: []
      })
      return
    }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, ops: [op] })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply inline edit.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = editablePath
      setActiveBlockId(focusBlockId)
      setActiveEditablePath(editablePath)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        if (indexedPath) {
          const listKey = indexedPath[1]
          const index = Number(indexedPath[2])
          const fieldKey = indexedPath[3]
          const typedOp = { op: "update_item" as const, pageSlug: slugForOp, blockId, listKey: listKey!, index, patch: { [fieldKey!]: value } }
          postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
        } else {
          const typedOp = { op: "update_props" as const, pageSlug: slugForOp, blockId, patch: { [editablePath]: value } }
          postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
        }
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not apply inline edit.",
        changes: []
      })
    }
  }

  async function submitChatHttp(finalMessage: string, options?: { executionMode?: ChatExecutionMode; pendingPlanId?: string }) {
    const res = await fetch(`${orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || undefined,
        siteHosting: activeSiteConfig.hosting || undefined,
        slug: slugRef.current,
        message: finalMessage,
        modelKey,
        provider,
        activeBlockId: activeBlockIdRef.current,
        activeBlockType: activeBlockTypeRef.current,
        activeEditablePath: activeEditablePathRef.current,
        executionMode: options?.executionMode ?? "auto",
        pendingPlanId: options?.pendingPlanId
      })
    })

    const data = (await res.json()) as AssistantResponse
    applyChatResult(data)
  }

  async function submitVariations(finalMessage: string) {
    const selectedBlockId = activeBlockIdRef.current
    const selectedBlockType = activeBlockTypeRef.current
    if (!selectedBlockId || !selectedBlockType) {
      pushAssistantFromResult({
        status: "needs_clarification",
        summary: "Select a block first, then ask to generate variations.",
        changes: []
      })
      return
    }

    const res = await fetch(`${orchestrator}/chat/variations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || undefined,
        siteHosting: activeSiteConfig.hosting || undefined,
        slug: slugRef.current,
        message: finalMessage,
        modelKey,
        provider,
        activeBlockId: selectedBlockId,
        activeBlockType: selectedBlockType,
        activeEditablePath: activeEditablePathRef.current
      })
    })

    const data = (await res.json()) as VariationResponse
    if (!res.ok || data.status !== "ok" || !Array.isArray(data.variations) || data.variations.length === 0) {
      pushAssistantFromResult({
        status: "error",
        summary: data.error ?? data.summary ?? "Could not generate variations.",
        changes: []
      })
      return
    }

    setVariationModal({
      requestText: finalMessage,
      blockId: data.blockId ?? selectedBlockId,
      blockType: data.blockType ?? selectedBlockType,
      pageSlug: data.pageSlug ?? slugRef.current,
      baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
      options: data.variations
    })
    pushAssistantFromResult({
      status: "info",
      summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
      changes: [`Block: ${data.blockType ?? selectedBlockType}`, `Options: ${data.variations.length}`]
    })
  }

  async function applyVariation(option: VariationOption) {
    if (!variationModal || isApplyingVariation) return
    setIsApplyingVariation(true)
    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session,
          siteId,
          ops: [
            {
              op: "update_props",
              pageSlug: variationModal.pageSlug,
              blockId: variationModal.blockId,
              patch: option.patch
            }
          ]
        })
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply variation.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? variationModal.blockId
      activeBlockIdRef.current = focusBlockId
      activeEditablePathRef.current = undefined
      setActiveBlockId(focusBlockId)
      setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "update_props" as const, pageSlug: variationModal.pageSlug, blockId: variationModal.blockId, patch: option.patch }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      setVariationModal(null)
      pushAssistantFromResult(
        {
          status: "applied",
          summary: `Applied variation: ${option.title}`,
          changes: [option.summary]
        },
        { canUndo: true }
      )
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not apply variation.",
        changes: []
      })
    } finally {
      setIsApplyingVariation(false)
    }
  }

  async function submitChatStream(finalMessage: string) {
    return await new Promise<boolean>((resolve) => {
      const params = new URLSearchParams({
        session,
        siteId,
        sitePurpose: activeSiteConfig.purpose || "",
        siteHosting: activeSiteConfig.hosting || "",
        slug: slugRef.current,
        message: finalMessage,
        modelKey,
        provider
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
          op?: Operation
          previewVersion?: number
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
          setStreamStatus(null)
          setStreamTokenCount(0)
          clearOpRefreshTimer()
          if (pendingFocusBlockId !== null) flushOpRefresh()
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

  async function submitChat(explicitMessage?: string, currentMessage?: string) {
    const finalMessage = (explicitMessage ?? currentMessage ?? "").trim()
    if (!finalMessage || isLoading) return

    // If there's a pending plan and the user types an approval-like message,
    // route through the plan approval flow instead of treating as a new request.
    if (pendingPlanId && /\b(approve|execute|go\s+ahead|yes|do\s+it|apply|confirm)\b/i.test(finalMessage)) {
      await approvePendingPlan(pendingPlanId)
      return
    }

    lastSentMessageRef.current = finalMessage
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: finalMessage }])
    setIsLoading(true)
    setStreamStatus(useStreaming ? "Connecting..." : null)
    setStreamTokenCount(0)
    try {
      if (isVariationRequest(finalMessage)) {
        await submitVariations(finalMessage)
        return
      }
      const requiresPlanApproval = isComplexTaskRequest(finalMessage)
      if (requiresPlanApproval) {
        setPendingPlanMessage(finalMessage)
        await submitChatHttp(finalMessage, { executionMode: "plan_only" })
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
      setIsLoading(false)
    }
  }

  async function approvePendingPlan(planId: string) {
    if (!planId || isLoading) return
    const originalMessage = pendingPlanMessage?.trim() || "Approve and execute the pending plan."
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Approve plan and execute." }])
    setIsLoading(true)
    try {
      await submitChatHttp(originalMessage, {
        executionMode: "apply_pending_plan",
        pendingPlanId: planId
      })
    } catch (error) {
      pushAssistantFromResult({
        status: "error",
        summary: `Plan execution failed: ${error instanceof Error ? error.message : "unknown error"}`,
        changes: []
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function stopPendingPlan(planId: string) {
    if (!planId || isLoading) return
    setChatLog((prev) => [...prev, { id: createId(), role: "user", text: "Stop and discard this plan." }])
    setIsLoading(true)
    try {
      await submitChatHttp("Stop pending plan.", {
        executionMode: "discard_pending_plan",
        pendingPlanId: planId
      })
    } finally {
      setIsLoading(false)
    }
  }

  async function applyUndoHistory(entryId: string) {
    if (isLoading || undoInFlightEntryId) return
    setUndoInFlightEntryId(entryId)
    try {
      const res = await fetch(`${orchestrator}/history/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, slug: slugRef.current })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") {
        pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Could not undo.",
          changes: []
        })
        return
      }

      activeEditablePathRef.current = undefined
      setActiveEditablePath(undefined)
      postToSite("draftUpdated", { focusBlockId: null })
      setChatLog((prev) => {
        const targetIndex = prev.findIndex((entry) => entry.id === entryId)
        if (targetIndex < 0) return prev

        const next = prev.map((entry, index) => (index === targetIndex ? { ...entry, canUndo: false, wasUndone: true } : entry))
        let promoteIndex = -1
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          const entry = next[index]
          if (entry.role === "assistant" && entry.status === "applied") {
            promoteIndex = index
            break
          }
        }
        if (promoteIndex >= 0) next[promoteIndex] = { ...next[promoteIndex], canUndo: true, wasUndone: false }
        return next
      })
    } catch {
      pushAssistantFromResult({
        status: "error",
        summary: "Could not undo.",
        changes: []
      })
    } finally {
      setUndoInFlightEntryId(null)
    }
  }

  return {
    chatLog,
    isLoading,
    streamStatus,
    streamTokenCount,
    plannerBadgeState,
    setPlannerBadgeState,
    pendingPlanId,
    variationModal,
    setVariationModal,
    isApplyingVariation,
    undoInFlightEntryId,
    pushAssistantFromResult,
    submitChat,
    applyVariation,
    approvePendingPlan,
    stopPendingPlan,
    applyUndoHistory,
    refreshRouteSlugs,
    reorderBlock,
    deleteBlock,
    inlineEditCommit
  }
}
