import type { Operation } from "@ai-site-editor/shared"
import type {
  ApplyOpsResponse,
  VariationModalState,
  VariationOption,
  VariationResponse
} from "../../lib/editor-types"
import {
  enablePatchTransport,
  orchestrator
} from "../../lib/editor-utils"
import { buildSiteContextPayload, withIntegrationContext } from "../../lib/integration-context"
import { useEditorStore } from "../../store"
import { getSessionId, getSiteId } from "../../store/session"
import type { ChatEngineSharedDeps } from "./types"

export type VariationsDeps = ChatEngineSharedDeps

export function useVariations(deps: VariationsDeps) {
  const store = useEditorStore

  async function submitVariations(finalMessage: string) {
    const { activeBlockId, activeBlockType, activeEditablePath, slug, modelKey, provider } = store.getState()
    if (!activeBlockId || !activeBlockType) {
      store.getState().pushAssistantFromResult({
        status: "needs_clarification",
        summary: "Select a block first, then ask to generate variations.",
        changes: []
      })
      return
    }

    const session = getSessionId()
    const siteId = getSiteId()
    const contextPayload = buildSiteContextPayload(siteId, deps.activeSiteConfig)
    const requestBody = withIntegrationContext({
      session,
      siteId,
      ...contextPayload,
      slug,
      message: finalMessage,
      modelKey,
      provider,
      activeBlockId,
      activeBlockType,
      activeEditablePath
    }, deps.componentManifest, deps.siteCapabilities)

    const res = await fetch(`${orchestrator}/chat/variations/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(requestBody)
    })

    if (!res.ok || !res.body) {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: `Could not generate variations (HTTP ${res.status}).`,
        changes: []
      })
      return
    }

    let modalOpened = false
    let announced = false

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let eolIndex: number
      while ((eolIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, eolIndex)
        buffer = buffer.slice(eolIndex + 2)
        const line = frame.split("\n").find((l) => l.startsWith("data: "))
        if (!line) continue
        const payload = JSON.parse(line.slice(6)) as { event?: string } & Record<string, unknown>
        if (payload.event === "variations_ready") {
          const data = payload as unknown as VariationResponse & { imagesPending?: boolean }
          if (!Array.isArray(data.variations) || data.variations.length === 0) continue
          const imagesPending = data.imagesPending === true
          store.getState().setVariationModal({
            requestText: finalMessage,
            blockId: data.blockId ?? activeBlockId,
            blockType: data.blockType ?? activeBlockType,
            pageSlug: data.pageSlug ?? slug,
            baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
            options: data.variations.map((v) => ({ ...v, imagePending: imagesPending }))
          })
          modalOpened = true
          if (!announced) {
            announced = true
            store.getState().pushAssistantFromResult({
              status: "info",
              summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
              changes: data.variations.map((v, i) => v.title?.trim() ? v.title.trim() : `Variation ${i + 1}`)
            })
          }
        } else if (payload.event === "image_resolved") {
          const update = payload as unknown as { variationId: string; patch: Record<string, unknown>; changedKeys: string[] }
          if (update.variationId && update.patch) {
            store.getState().patchVariationOption(update.variationId, {
              patch: update.patch,
              changedKeys: update.changedKeys ?? Object.keys(update.patch)
            })
          }
        } else if (payload.event === "error") {
          if (!modalOpened) {
            store.getState().pushAssistantFromResult({
              status: "error",
              summary: (payload.error as string) ?? "Could not generate variations.",
              changes: []
            })
          }
        }
        // "done" is a no-op — final option state already arrived via image_resolved events.
      }
    }
  }

  async function applyVariation(option: VariationOption) {
    const { variationModal, isApplyingVariation } = store.getState()
    if (!variationModal || isApplyingVariation) return
    store.getState().setIsApplyingVariation(true)
    const session = getSessionId()
    const siteId = getSiteId()
    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({
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
        }, deps.componentManifest, deps.siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply variation.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? variationModal.blockId
      store.getState().setActiveBlock(focusBlockId)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "update_props" as const, pageSlug: variationModal.pageSlug, blockId: variationModal.blockId, patch: option.patch }
        deps.postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        deps.postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().setVariationModal(null)
      store.getState().pushAssistantFromResult(
        {
          status: "applied",
          summary: `Applied variation: ${option.title}`,
          changes: [option.summary]
        },
        { canUndo: true }
      )
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not apply variation.",
        changes: []
      })
    } finally {
      store.getState().setIsApplyingVariation(false)
    }
  }

  return {
    submitVariations,
    applyVariation
  }
}
