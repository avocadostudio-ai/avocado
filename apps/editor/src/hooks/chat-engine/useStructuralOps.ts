import { useRef } from "react"
import { useT } from "../../i18n"
import {
  defaultListItemForBlock,
  defaultPropsForType,
  type Operation
} from "@ai-site-editor/shared"
import type { ApplyOpsResponse } from "../../lib/editor-types"
import {
  enablePatchTransport,
  orchestrator
} from "../../lib/editor-utils"
import { manifestUnavailableChanges, withIntegrationContext } from "../../lib/integration-context"
import { useEditorStore } from "../../store"
import { getSessionId, getSiteId } from "../../store/session"
import type { ChatEngineSharedDeps } from "./types"

export type StructuralOpsConfig = ChatEngineSharedDeps

export function useStructuralOps(config: StructuralOpsConfig) {
  const {
    postToSite,
    postPatchToSite,
    componentManifest,
    siteCapabilities,
    allowStructuralEdits,
    getBlockDefaultProps,
  } = config

  const store = useEditorStore
  const { t } = useT()
  const lastStructuralNoticeRef = useRef<number>(0)

  const pushStructuralDisabledNotice = (action: string) => {
    const now = Date.now()
    if (now - lastStructuralNoticeRef.current < 1200) return
    lastStructuralNoticeRef.current = now
    const reason = siteCapabilities?.reason?.trim()
    store.getState().pushAssistantFromResult({
      status: "needs_clarification",
      summary: `Cannot ${action} because structural editing is currently disabled.`,
      changes: manifestUnavailableChanges(reason)
    })
  }

  async function addBlockAfter(
    slugForOp: string,
    afterBlockId: string | undefined,
    blockType: string,
    beforeBlockId?: string,
    defaultPropsOverride?: Record<string, unknown>
  ) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("add a block")
      return false
    }
    if (!blockType) return false

    const session = getSessionId()
    const siteId = getSiteId()
    const normalizedType = blockType.trim()
    const safeType = normalizedType.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    const block = {
      id: `b_${safeType}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: normalizedType,
      props: defaultPropsOverride ?? getBlockDefaultProps?.(normalizedType) ?? defaultPropsForType(normalizedType)
    }
    const isInsertAtTop = Boolean(beforeBlockId && !afterBlockId)
    const addOp: Record<string, unknown> = { op: "add_block", pageSlug: slugForOp, block }
    if (afterBlockId) addOp.afterBlockId = afterBlockId
    const ops: Record<string, unknown>[] = isInsertAtTop
      ? [addOp, { op: "move_block", pageSlug: slugForOp, blockId: block.id }]
      : [addOp]

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not add block.",
          changes: data.changes ?? []
        })
        return false
      }

      const focusBlockId = data.focusBlockId ?? block.id
      store.getState().setActiveBlock(focusBlockId, normalizedType)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number" && !isInsertAtTop) {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "add_block" as const, pageSlug: slugForOp, ...(afterBlockId ? { afterBlockId } : {}), block }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: `Added ${normalizedType} block.` }, { canUndo: true })
      return true
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not add block.",
        changes: []
      })
      return false
    }
  }

  async function reorderBlock(slugForOp: string, blockId: string, afterBlockId?: string) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("reorder blocks")
      return
    }
    if (!blockId) return
    const session = getSessionId()
    const siteId = getSiteId()
    const op: Record<string, unknown> = { op: "move_block", pageSlug: slugForOp, blockId }
    if (afterBlockId) op.afterBlockId = afterBlockId

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not reorder blocks.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      if (focusBlockId !== store.getState().activeBlockId) {
        store.getState().setActiveBlock(focusBlockId)
      }
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "move_block" as const, pageSlug: slugForOp, blockId, ...(afterBlockId ? { afterBlockId } : {}) }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: "Moved block." }, { canUndo: true })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not reorder blocks.",
        changes: []
      })
    }
  }

  async function addListItem(slugForOp: string, blockId: string, blockType: string, listKey: string, afterIndex?: number) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("add list items")
      return
    }
    if (!blockId || !blockType || !listKey) return
    const session = getSessionId()
    const siteId = getSiteId()
    const fallbackItem = { title: "New item", description: "Describe this item." }
    const item = defaultListItemForBlock(blockType, listKey) ?? fallbackItem
    const op: Record<string, unknown> = { op: "add_item", pageSlug: slugForOp, blockId, listKey, item }
    if (typeof afterIndex === "number" && Number.isInteger(afterIndex) && afterIndex >= 0) op.afterIndex = afterIndex

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not add item.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      store.getState().setActiveBlock(focusBlockId, blockType)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = {
          op: "add_item" as const,
          pageSlug: slugForOp,
          blockId,
          listKey,
          item,
          ...(typeof afterIndex === "number" && Number.isInteger(afterIndex) && afterIndex >= 0 ? { afterIndex } : {})
        }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: t("ops.addedItem") }, { canUndo: true })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not add item.",
        changes: []
      })
    }
  }

  async function removeListItem(slugForOp: string, blockId: string, blockType: string, listKey: string, index: number) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("remove list items")
      return
    }
    if (!blockId || !blockType || !listKey || !Number.isInteger(index) || index < 0) return
    const session = getSessionId()
    const siteId = getSiteId()
    const op = { op: "remove_item", pageSlug: slugForOp, blockId, listKey, index }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not remove item.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      store.getState().setActiveBlock(focusBlockId, blockType)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "remove_item" as const, pageSlug: slugForOp, blockId, listKey, index }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: "Removed list item." }, { canUndo: true })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not remove item.",
        changes: []
      })
    }
  }

  async function moveListItem(slugForOp: string, blockId: string, blockType: string, listKey: string, index: number, afterIndex?: number) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("reorder list items")
      return
    }
    if (!blockId || !blockType || !listKey || !Number.isInteger(index) || index < 0) return
    const session = getSessionId()
    const siteId = getSiteId()
    const op: Record<string, unknown> = { op: "move_item", pageSlug: slugForOp, blockId, listKey, index }
    if (typeof afterIndex === "number" && Number.isInteger(afterIndex) && afterIndex >= 0) op.afterIndex = afterIndex

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not reorder items.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      store.getState().setActiveBlock(focusBlockId, blockType)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = {
          op: "move_item" as const,
          pageSlug: slugForOp,
          blockId,
          listKey,
          index,
          ...(typeof afterIndex === "number" && Number.isInteger(afterIndex) && afterIndex >= 0 ? { afterIndex } : {})
        }
        postPatchToSite(typedOp, fromVersion, toVersion, focusBlockId)
      } else {
        postToSite("draftUpdated", { focusBlockId })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: "Moved list item." }, { canUndo: true })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not reorder items.",
        changes: []
      })
    }
  }

  async function deleteBlock(slugForOp: string, blockId: string) {
    if (!allowStructuralEdits) {
      pushStructuralDisabledNotice("delete blocks")
      return
    }
    if (!blockId) return
    const session = getSessionId()
    const siteId = getSiteId()
    const op = { op: "remove_block", pageSlug: slugForOp, blockId }

    try {
      const res = await fetch(`${orchestrator}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not delete block.",
          changes: data.changes ?? []
        })
        return
      }

      store.getState().setActiveBlock(undefined, undefined)
      store.getState().setActiveEditablePath(undefined)
      if (enablePatchTransport && typeof data.previewVersion === "number") {
        const toVersion = data.previewVersion
        const fromVersion = toVersion - 1
        const typedOp = { op: "remove_block" as const, pageSlug: slugForOp, blockId }
        postPatchToSite(typedOp, fromVersion, toVersion)
      } else {
        postToSite("draftUpdated", { focusBlockId: null })
      }
      store.getState().pushAssistantFromResult({ status: "applied", summary: t("ops.deletedBlock") }, { canUndo: true })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not delete block.",
        changes: []
      })
    }
  }

  async function inlineEditCommit(slugForOp: string, blockId: string, editablePath: string, value: string, options?: { silent?: boolean }) {
    if (!blockId || !editablePath) return
    const session = getSessionId()
    const siteId = getSiteId()

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
      store.getState().pushAssistantFromResult({
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
        body: JSON.stringify(withIntegrationContext({ session, siteId, ops: [op] }, componentManifest, siteCapabilities))
      })
      const data = (await res.json()) as ApplyOpsResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? data.summary ?? "Could not apply inline edit.",
          changes: data.changes ?? []
        })
        return
      }

      const focusBlockId = data.focusBlockId ?? blockId
      if (focusBlockId !== store.getState().activeBlockId) {
        store.getState().setActiveBlock(focusBlockId)
      }
      store.getState().setActiveEditablePath(editablePath)
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
      if (!options?.silent) {
        const fieldLabel = editablePath.replace(/.*\./, "").replace(/([A-Z])/g, " $1").toLowerCase().trim()
        store.getState().pushAssistantFromResult({ status: "applied", summary: `Edited ${fieldLabel}.` }, { canUndo: true })
      }
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not apply inline edit.",
        changes: []
      })
    }
  }

  return {
    addBlockAfter,
    reorderBlock,
    addListItem,
    removeListItem,
    moveListItem,
    deleteBlock,
    inlineEditCommit
  }
}
