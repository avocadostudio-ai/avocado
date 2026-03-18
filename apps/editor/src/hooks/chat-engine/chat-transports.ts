import type { EditorComponentsManifest, Operation } from "@ai-site-editor/shared"
import type {
  AIProvider,
  AssistantResponse,
  ChatExecutionMode,
  ModelKey,
  SiteCapabilities,
  SiteConfig,
  VariationModalState,
  VariationResponse
} from "../../lib/editor-types"
import { buildSiteContextPayload, withIntegrationContext } from "../../lib/integration-context"

// Chat transport adapters used by useChatEngine.
// They isolate HTTP/SSE request mechanics from hook state orchestration.
type ChatMessagePayload = {
  executionMode?: ChatExecutionMode
  pendingPlanId?: string
}

type Ref<T> = { current: T }

type CreateChatTransportsArgs = {
  orchestrator: string
  session: string
  siteId: string
  activeSiteConfig: SiteConfig
  modelKey: ModelKey
  provider: AIProvider
  componentManifest?: EditorComponentsManifest | null
  siteCapabilities?: SiteCapabilities
  activeBlockIdRef: Ref<string | undefined>
  activeBlockTypeRef: Ref<string | undefined>
  activeEditablePathRef: Ref<string | undefined>
  slugRef: Ref<string>
  blockIdFromOperation: (op?: Operation) => string | null
  applyChatResult: (data: AssistantResponse) => void
  pushAssistantFromResult: (data: AssistantResponse) => void
  setVariationModal: (state: VariationModalState | null) => void
  postToSite: (type: "draftUpdated" | "liveDraft" | "showSkeleton" | "removeSkeleton", payload: Record<string, unknown>) => void
  postPatchToSite: (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => void
  setActiveBlockId: (id: string | undefined) => void
  setActiveEditablePath: (value: string | undefined) => void
  setStreamStatus: (value: string | null) => void
  setStreamSteps: (value: { label: string; done: boolean }[] | ((prev: { label: string; done: boolean }[]) => { label: string; done: boolean }[])) => void
  setStreamTokenCount: (value: number | ((prev: number) => number)) => void
  setLatestStreamFocusBlockId: (value: string | null) => void
  enablePatchTransport: boolean
}

/** Detect if a /chat response is actually a VariationResult routed through the chat pipeline. */
function isVariationResult(data: unknown): data is VariationResponse & { status: "ok"; variations: NonNullable<VariationResponse["variations"]> } {
  const d = data as Record<string, unknown>
  return d.status === "ok" && Array.isArray(d.variations) && d.variations.length > 0
}

export function createChatTransports(args: CreateChatTransportsArgs) {
  /** Handle a /chat response that may be a VariationResult routed through the chat pipeline. */
  function applyChatOrVariationResult(data: AssistantResponse, messageText: string) {
    if (isVariationResult(data)) {
      const selectedBlockId = args.activeBlockIdRef.current
      const selectedBlockType = args.activeBlockTypeRef.current
      args.setVariationModal({
        requestText: messageText,
        blockId: data.blockId ?? selectedBlockId ?? "",
        blockType: data.blockType ?? selectedBlockType ?? "",
        pageSlug: data.pageSlug ?? args.slugRef.current,
        baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
        options: data.variations
      })
      args.pushAssistantFromResult({
        status: "info",
        summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
        changes: [`Block: ${data.blockType ?? selectedBlockType}`, `Options: ${data.variations.length}`]
      })
      return
    }
    args.applyChatResult(data)
  }

  async function submitChatHttp(finalMessage: string, options?: ChatMessagePayload) {
    const contextPayload = buildSiteContextPayload(args.siteId, args.activeSiteConfig)
    const res = await fetch(`${args.orchestrator}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
        session: args.session,
        siteId: args.siteId,
        ...contextPayload,
        slug: args.slugRef.current,
        message: finalMessage,
        modelKey: args.modelKey,
        provider: args.provider,
        activeBlockId: args.activeBlockIdRef.current,
        activeBlockType: args.activeBlockTypeRef.current,
        activeEditablePath: args.activeEditablePathRef.current,
        executionMode: options?.executionMode ?? "auto",
        pendingPlanId: options?.pendingPlanId
      }, args.componentManifest, args.siteCapabilities))
    })

    const data = (await res.json()) as AssistantResponse
    applyChatOrVariationResult(data, finalMessage)
  }

  async function submitVariations(finalMessage: string) {
    const selectedBlockId = args.activeBlockIdRef.current
    const selectedBlockType = args.activeBlockTypeRef.current
    if (!selectedBlockId || !selectedBlockType) {
      args.pushAssistantFromResult({
        status: "needs_clarification",
        summary: "Select a block first, then ask to generate variations.",
        changes: []
      })
      return
    }

    const contextPayload = buildSiteContextPayload(args.siteId, args.activeSiteConfig)
    const res = await fetch(`${args.orchestrator}/chat/variations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
        session: args.session,
        siteId: args.siteId,
        ...contextPayload,
        slug: args.slugRef.current,
        message: finalMessage,
        modelKey: args.modelKey,
        provider: args.provider,
        activeBlockId: selectedBlockId,
        activeBlockType: selectedBlockType,
        activeEditablePath: args.activeEditablePathRef.current
      }, args.componentManifest, args.siteCapabilities))
    })

    const data = (await res.json()) as VariationResponse
    if (!res.ok || data.status !== "ok" || !Array.isArray(data.variations) || data.variations.length === 0) {
      args.pushAssistantFromResult({
        status: "error",
        summary: data.error ?? data.summary ?? "Could not generate variations.",
        changes: []
      })
      return
    }

    args.setVariationModal({
      requestText: finalMessage,
      blockId: data.blockId ?? selectedBlockId,
      blockType: data.blockType ?? selectedBlockType,
      pageSlug: data.pageSlug ?? args.slugRef.current,
      baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
      options: data.variations
    })
    args.pushAssistantFromResult({
      status: "info",
      summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
      changes: [`Block: ${data.blockType ?? selectedBlockType}`, `Options: ${data.variations.length}`]
    })
  }

  async function submitChatStream(finalMessage: string, extraParams?: Record<string, string>) {
    const contextPayload = buildSiteContextPayload(args.siteId, args.activeSiteConfig)
    const payload = withIntegrationContext({
      session: args.session,
      siteId: args.siteId,
      ...contextPayload,
      slug: args.slugRef.current,
      message: finalMessage,
      modelKey: args.modelKey,
      provider: args.provider,
      activeBlockId: args.activeBlockIdRef.current,
      activeBlockType: args.activeBlockTypeRef.current,
      activeEditablePath: args.activeEditablePathRef.current,
      ...(extraParams ?? {})
    }, args.componentManifest, args.siteCapabilities)

    // Show immediate feedback before any SSE events arrive
    args.setStreamStatus("Thinking...")

    let streamId: string
    try {
      const res = await fetch(`${args.orchestrator}/chat/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
      if (!res.ok) return false
      const data = await res.json() as { streamId?: string }
      if (!data.streamId) return false
      streamId = data.streamId
    } catch {
      return false
    }

    return await new Promise<boolean>((resolve) => {
      const source = new EventSource(`${args.orchestrator}/chat/stream?streamId=${streamId}`)
      let settled = false
      let gotAnyEvent = false
      let pendingFocusBlockId: string | null = null
      let opRefreshTimer: number | null = null
      let lastOpAppliedAt = 0
      let lastOpTotal = 0
      let appliedOpCount = 0
      let skippedOpCount = 0
      let liveDraftBlockId: string | null = args.activeBlockIdRef.current ?? null
      let liveDraftText = ""
      let liveDraftFlushTimer: number | null = null
      let liveDraftActive = false
      let liveDraftFields: Record<string, string> | null = null
      let currentStepLabel: string | null = null
      let currentStepStartedAt = 0
      const MIN_STEP_DURATION_MS = 800

      const normalizeStepLabel = (s: string) =>
        s.replace(/[\u2026.]+$/, "").replace(/\s*\([\d/,\s]+\)$/, "").trim()
      const advanceStep = (label: string) => {
        const baseLabel = normalizeStepLabel(label)
        const prevBase = currentStepLabel ? normalizeStepLabel(currentStepLabel) : null
        if (baseLabel === prevBase) {
          currentStepLabel = label
          const display = label.replace(/[\u2026.]+$/, "").trim()
          args.setStreamSteps((prev) => {
            if (prev.length === 0) return prev
            const last = prev[prev.length - 1]
            if (last.done || last.label === display) return prev
            return [...prev.slice(0, -1), { ...last, label: display }]
          })
          return
        }

        const now = Date.now()
        const prevWasLongEnough = currentStepStartedAt > 0 && (now - currentStepStartedAt) >= MIN_STEP_DURATION_MS

        currentStepLabel = label
        currentStepStartedAt = now
        const display = label.replace(/[\u2026.]+$/, "").trim()

        if (prevWasLongEnough) {
          // Previous step was visible long enough — promote it to done, then add the new one
          args.setStreamSteps((prev) => {
            const next = prev.map((s) => (s.done ? s : { ...s, done: true }))
            next.push({ label: display, done: false })
            return next
          })
        } else {
          // Previous step was too brief — silently replace it instead of marking done
          args.setStreamSteps((prev) => {
            if (prev.length === 0) return [{ label: display, done: false }]
            const doneSteps = prev.filter((s) => s.done)
            return [...doneSteps, { label: display, done: false }]
          })
        }
      }

      const sendLiveDraft = (force = false) => {
        if (!liveDraftBlockId) return
        if (!force && !liveDraftActive) return
        args.postToSite("liveDraft", {
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
        args.postToSite("draftUpdated", { focusBlockId: pendingFocusBlockId })
        if (pendingFocusBlockId) {
          args.activeBlockIdRef.current = pendingFocusBlockId
          args.setActiveBlockId(pendingFocusBlockId)
        }
        args.activeEditablePathRef.current = undefined
        args.setActiveEditablePath(undefined)
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
          type: "status" | "token" | "field_draft" | "plan_meta" | "op_candidate" | "op_applied" | "op_skipped" | "heartbeat" | "rollback_started" | "rollback_done" | "final" | "error"
          message?: string
          text?: string
          blockId?: string
          editablePath?: string
          value?: string
          stage?: string
          label?: string
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

        if (payload.type === "status") {
          const msg = payload.message ?? "Working..."
          args.setStreamStatus(msg)
          advanceStep(msg)
        }

        if (payload.type === "token") {
          const text = payload.text ?? ""
          if (text) {
            args.setStreamTokenCount((prev) => prev + text.length)
          }
        }

        if (payload.type === "field_draft") {
          const blockId = typeof payload.blockId === "string" ? payload.blockId : ""
          const editablePath = typeof payload.editablePath === "string" ? payload.editablePath : ""
          const value = typeof payload.value === "string" ? payload.value : ""
          if (blockId && editablePath) {
            liveDraftBlockId = blockId
            args.setLatestStreamFocusBlockId(blockId)
            liveDraftFields = { [editablePath]: value }
            liveDraftActive = true
            scheduleLiveDraftFlush()
          }
        }

        if (payload.type === "plan_meta") {
          const estimatedOps = Number(payload.estimatedOps ?? 0)
          const planLabel = estimatedOps > 0
            ? `Plan ready (${estimatedOps} change${estimatedOps === 1 ? "" : "s"})`
            : "Plan ready"
          args.setStreamStatus(`${planLabel}...`)
          advanceStep(planLabel)
        }

        if (payload.type === "op_candidate") {
          const idx = Number(payload.index ?? 0)
          if (!liveDraftBlockId) {
            const derived = args.blockIdFromOperation(payload.op)
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
              args.postToSite("showSkeleton", {
                afterBlockId: typeof afterBlockId === "string" ? afterBlockId : null,
                blockType: typeof blockObj?.type === "string" ? blockObj.type : "Block"
              })
            }
          }

          args.setStreamStatus(idx > 0 ? `Drafting operation ${idx}...` : "Drafting operations...")
        }

        if (payload.type === "heartbeat") {
          const elapsedSec = Math.max(0, Math.floor(Number(payload.elapsedMs ?? 0) / 1000))
          const label = payload.label ?? (payload.stage === "applying" ? "Applying" : "Planning")
          args.setStreamStatus(`${label}… ${elapsedSec}s`)
        }

        if (payload.type === "op_applied") {
          if (liveDraftActive) endLiveDraft()
          args.postToSite("removeSkeleton", {})
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          appliedOpCount += 1
          advanceStep(total > 0 ? `Applying changes (${appliedOpCount}/${total})` : "Applying changes")
          if (total > 0 && index > 0) {
            const suffix = skippedOpCount > 0 ? `, skipped ${skippedOpCount}` : ""
            args.setStreamStatus(`Applying changes (${index}/${total}, applied ${appliedOpCount}${suffix})...`)
          } else {
            const suffix = skippedOpCount > 0 ? `, skipped ${skippedOpCount}` : ""
            args.setStreamStatus(`Applying changes (applied ${appliedOpCount}${suffix})...`)
          }
          pendingFocusBlockId = typeof payload.focusBlockId === "string" ? payload.focusBlockId : null
          if (pendingFocusBlockId) args.setLatestStreamFocusBlockId(pendingFocusBlockId)
          lastOpAppliedAt = Date.now()
          lastOpTotal = total > 0 ? total : index > 0 ? index : lastOpTotal
          if (args.enablePatchTransport && payload.op && typeof payload.previewVersion === "number") {
            const toVersion = payload.previewVersion
            const fromVersion = toVersion - 1
            args.postPatchToSite(payload.op, fromVersion, toVersion, pendingFocusBlockId ?? undefined)
          } else if (total > 0 && index >= total) {
            clearOpRefreshTimer()
            flushOpRefresh()
          } else {
            scheduleOpRefresh()
          }
        }

        if (payload.type === "op_skipped") {
          skippedOpCount += 1
          const total = Number(payload.total ?? 0)
          const index = Number(payload.index ?? 0)
          if (total > 0 && index > 0) {
            args.setStreamStatus(`Applying changes (${index}/${total}, applied ${appliedOpCount}, skipped ${skippedOpCount})...`)
          } else {
            args.setStreamStatus(`Applying changes (applied ${appliedOpCount}, skipped ${skippedOpCount})...`)
          }
        }

        if (payload.type === "rollback_started") {
          endLiveDraft()
          args.setStreamStatus("Rolling back partial changes...")
        }

        if (payload.type === "rollback_done") {
          args.setStreamStatus("Rollback complete. Syncing preview...")
          args.postToSite("draftUpdated", { focusBlockId: null })
        }

        if (payload.type === "final") {
          const completeFinal = () => {
            settled = true
            args.setStreamStatus(null)
            args.setStreamSteps([])
            args.setStreamTokenCount(0)
            clearOpRefreshTimer()
            endLiveDraft()
            if (pendingFocusBlockId !== null) flushOpRefresh()
            if (payload.result) applyChatOrVariationResult(payload.result, finalMessage)
            if (payload.result?.focusBlockId) args.setLatestStreamFocusBlockId(payload.result.focusBlockId)
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
              args.setStreamStatus(`Applied ${applied}/${appliedTotal}${skipped > 0 ? `, skipped ${skipped}` : ""}...`)
            } else {
              args.setStreamStatus("Applied changes...")
            }
            window.setTimeout(completeFinal, minVisibleMs - elapsedSinceLastOp)
          } else {
            completeFinal()
          }
        }

        if (payload.type === "error") {
          settled = true
          args.setStreamStatus(null)
          args.setStreamSteps([])
          args.setStreamTokenCount(0)
          clearOpRefreshTimer()
          endLiveDraft()
          pendingFocusBlockId = null
          if (payload.result) {
            applyChatOrVariationResult(payload.result, finalMessage)
          } else {
            args.pushAssistantFromResult({ status: "error", summary: "Streaming request failed.", changes: [] })
          }
          source.close()
          resolve(true)
        }
      }

      source.onerror = () => {
        if (settled || gotAnyEvent) {
          args.setStreamStatus(null)
          args.setStreamSteps([])
          args.setStreamTokenCount(0)
          clearOpRefreshTimer()
          endLiveDraft()
          if (pendingFocusBlockId !== null) flushOpRefresh()
          pendingFocusBlockId = null
          source.close()
          resolve(true)
          return
        }
        args.setStreamStatus("Streaming failed, retrying with standard request...")
        args.setStreamTokenCount(0)
        clearOpRefreshTimer()
        endLiveDraft()
        pendingFocusBlockId = null
        settled = true
        source.close()
        resolve(false)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Prefetch — call as user types (debounced) to warm up deterministic intent.
  // Returns estimated latency class so UI can hint "instant" vs "a few seconds".
  // -------------------------------------------------------------------------
  let prefetchAbort: AbortController | null = null
  async function prefetchIntent(partialMessage: string): Promise<{
    likelyDeterministic: boolean
    estimatedLatency: "instant" | "moderate" | "slow"
    inferredAction: string | null
  } | null> {
    // Abort previous in-flight prefetch
    prefetchAbort?.abort()
    prefetchAbort = new AbortController()
    const { signal } = prefetchAbort

    try {
      const res = await fetch(`${args.orchestrator}/chat/prefetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: args.session,
          siteId: args.siteId,
          slug: args.slugRef.current,
          message: partialMessage,
          activeBlockId: args.activeBlockIdRef.current,
          activeEditablePath: args.activeEditablePathRef.current
        }),
        signal
      })
      if (!res.ok) return null
      return await res.json() as {
        likelyDeterministic: boolean
        estimatedLatency: "instant" | "moderate" | "slow"
        inferredAction: string | null
      }
    } catch {
      return null // Aborted or network error — silently ignore
    }
  }

  return { submitChatHttp, submitVariations, submitChatStream, prefetchIntent }
}
