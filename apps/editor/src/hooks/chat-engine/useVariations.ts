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
    const res = await fetch(`${orchestrator}/chat/variations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
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
      }, deps.componentManifest, deps.siteCapabilities))
    })

    const data = (await res.json()) as VariationResponse
    if (!res.ok || data.status !== "ok" || !Array.isArray(data.variations) || data.variations.length === 0) {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: data.error ?? data.summary ?? "Could not generate variations.",
        changes: []
      })
      return
    }

    store.getState().setVariationModal({
      requestText: finalMessage,
      blockId: data.blockId ?? activeBlockId,
      blockType: data.blockType ?? activeBlockType,
      pageSlug: data.pageSlug ?? slug,
      baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
      options: data.variations
    })
    store.getState().pushAssistantFromResult({
      status: "info",
      summary: data.summary ?? `Generated ${data.variations.length} variations. Choose one from the modal.`,
      changes: [`Block: ${data.blockType ?? activeBlockType}`, `Options: ${data.variations.length}`]
    })
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
