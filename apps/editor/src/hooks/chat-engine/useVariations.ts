import { useState } from "react"
import type { Operation } from "@ai-site-editor/shared"
import type {
  ApplyOpsResponse,
  AssistantResponse,
  VariationModalState,
  VariationOption,
  VariationResponse
} from "../../lib/editor-types"
import {
  enablePatchTransport,
  orchestrator
} from "../../lib/editor-utils"
import { buildSiteContextPayload, withIntegrationContext } from "../../lib/integration-context"
import type { AIProvider, ModelKey } from "../../lib/editor-types"
import type { ChatEngineSharedDeps } from "./types"

export type VariationsDeps = ChatEngineSharedDeps & {
  slugRef: React.RefObject<string>
  modelKey: ModelKey
  provider: AIProvider
}

export function useVariations(deps: VariationsDeps) {
  const [variationModal, setVariationModal] = useState<VariationModalState | null>(null)
  const [isApplyingVariation, setIsApplyingVariation] = useState(false)

  async function submitVariations(finalMessage: string) {
    const selectedBlockId = deps.activeBlockIdRef.current
    const selectedBlockType = deps.activeBlockTypeRef.current
    if (!selectedBlockId || !selectedBlockType) {
      deps.pushAssistantFromResult({
        status: "needs_clarification",
        summary: "Select a block first, then ask to generate variations.",
        changes: []
      })
      return
    }

    const contextPayload = buildSiteContextPayload(deps.siteId, deps.activeSiteConfig)
    const res = await fetch(`${orchestrator}/chat/variations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withIntegrationContext({
        session: deps.session,
        siteId: deps.siteId,
        ...contextPayload,
        slug: deps.slugRef.current,
        message: finalMessage,
        modelKey: deps.modelKey,
        provider: deps.provider,
        activeBlockId: selectedBlockId,
        activeBlockType: selectedBlockType,
        activeEditablePath: deps.activeEditablePathRef.current
      }, deps.componentManifest, deps.siteCapabilities))
    })

    const data = (await res.json()) as VariationResponse
    if (!res.ok || data.status !== "ok" || !Array.isArray(data.variations) || data.variations.length === 0) {
      deps.pushAssistantFromResult({
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
      pageSlug: data.pageSlug ?? deps.slugRef.current,
      baseProps: (data.baseProps && typeof data.baseProps === "object" ? data.baseProps : {}) as Record<string, unknown>,
      options: data.variations
    })
    deps.pushAssistantFromResult({
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
        body: JSON.stringify(withIntegrationContext({
          session: deps.session,
          siteId: deps.siteId,
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
        deps.pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply variation.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? variationModal.blockId
      deps.activeBlockIdRef.current = focusBlockId
      deps.activeEditablePathRef.current = undefined
      deps.setActiveBlockId(focusBlockId)
      deps.setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "update_props" as const, pageSlug: variationModal.pageSlug, blockId: variationModal.blockId, patch: option.patch }
        deps.postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        deps.postToSite("draftUpdated", { focusBlockId })
      }
      setVariationModal(null)
      deps.pushAssistantFromResult(
        {
          status: "applied",
          summary: `Applied variation: ${option.title}`,
          changes: [option.summary]
        },
        { canUndo: true }
      )
    } catch {
      deps.pushAssistantFromResult({
        status: "error",
        summary: "Could not apply variation.",
        changes: []
      })
    } finally {
      setIsApplyingVariation(false)
    }
  }

  return {
    variationModal,
    setVariationModal,
    isApplyingVariation,
    submitVariations,
    applyVariation
  }
}
