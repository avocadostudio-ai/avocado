import { useEffect, useRef } from "react"
import type { ApplyPatchMessage, Operation } from "@ai-site-editor/shared"
import type { SiteMessage } from "../lib/editor-types"
import { siteOrigin } from "../lib/editor-utils"

export type PreviewBridgeCallbacks = {
  onBlockClicked: (slug: string, blockId: string | undefined, blockType: string | undefined, editablePath: string | undefined) => void
  onRouteChanged: (slug: string) => void
  onBlockReordered: (slug: string, blockId: string, afterBlockId: string | undefined) => void
  onBlockDeleteRequested: (slug: string, blockId: string) => void
  onBlockAddRequested: (slug: string, args: { afterBlockId?: string; beforeBlockId?: string }) => void
  onListItemAddRequested: (slug: string, blockId: string, blockType: string, listKey: string, afterIndex: number | undefined) => void
  onListItemRemoveRequested: (slug: string, blockId: string, blockType: string, listKey: string, index: number) => void
  onListItemMoveRequested: (slug: string, blockId: string, blockType: string, listKey: string, index: number, afterIndex: number | undefined) => void
  onInlineTextCommitted: (slug: string, blockId: string, editablePath: string, value: string) => void
}

export function usePreviewBridge(slug: string, callbacks: PreviewBridgeCallbacks) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const lastConfirmedVersionBySlug = useRef<Map<string, number>>(new Map())
  const pendingTxBySlug = useRef<Map<string, { txId: string; timer: ReturnType<typeof setTimeout> }>>(new Map())

  const postToSite = (
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft",
    payload: Record<string, unknown>
  ) => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        protocol: "site-editor/v1",
        type,
        payload
      },
      siteOrigin
    )
  }

  const postPatchToSite = (op: Operation, fromVersion: number, toVersion: number, focusBlockId?: string) => {
    const txId = crypto.randomUUID()
    const msg: ApplyPatchMessage = { type: "applyPatch", txId, op, fromVersion, toVersion, focusBlockId }
    iframeRef.current?.contentWindow?.postMessage({ source: "site-editor/v1", ...msg }, siteOrigin)
    const pageSlug = "pageSlug" in op ? (op.pageSlug ?? "") : ""
    // Timeout fallback: if no ack within 3s, fall back to draftUpdated
    const timer = setTimeout(() => {
      pendingTxBySlug.current.delete(pageSlug)
      postToSite("draftUpdated", { focusBlockId: focusBlockId ?? null })
    }, 3000)
    pendingTxBySlug.current.set(pageSlug, { txId, timer })
    lastConfirmedVersionBySlug.current.set(pageSlug, toVersion)
    return txId
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== siteOrigin) return
      const msg = event.data
      if (!msg) return

      // Handle patchAck from patch transport (uses source instead of protocol)
      if ("source" in msg && msg.source === "site-editor/v1" && msg.type === "patchAck") {
        const pending = [...pendingTxBySlug.current.entries()].find(([, v]) => v.txId === msg.txId)
        if (pending) {
          clearTimeout(pending[1].timer)
          pendingTxBySlug.current.delete(pending[0])
          if (!msg.accepted) {
            // version mismatch or apply error — fall back to full refresh
            postToSite("draftUpdated", {})
          }
        }
        return
      }

      if (!("protocol" in msg) || msg.protocol !== "site-editor/v1") return

      if (msg.type === "blockClicked") {
        const rawBlockId = msg.payload.blockId
        const rawBlockType = msg.payload.blockType
        const rawPath = msg.payload.editablePath
        const nextBlockId = typeof rawBlockId === "string" && rawBlockId.length > 0 ? rawBlockId : undefined
        const nextBlockType = typeof rawBlockType === "string" && rawBlockType.length > 0 ? rawBlockType : undefined
        const nextPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : undefined
        callbacks.onBlockClicked(String(msg.payload.slug ?? "/"), nextBlockId, nextBlockType, nextPath)
      }

      if (msg.type === "routeChanged") {
        callbacks.onRouteChanged(String(msg.payload.slug ?? "/"))
      }

      if (msg.type === "blockReordered") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const afterRaw = msg.payload.afterBlockId
        const afterBlockId = typeof afterRaw === "string" && afterRaw.length > 0 ? afterRaw : undefined
        callbacks.onBlockReordered(nextSlug, blockId, afterBlockId)
      }

      if (msg.type === "blockDeleteRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        callbacks.onBlockDeleteRequested(nextSlug, blockId)
      }

      if (msg.type === "blockAddRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const afterBlockId =
          typeof msg.payload.afterBlockId === "string" && msg.payload.afterBlockId.length > 0 ? msg.payload.afterBlockId : undefined
        const beforeBlockId =
          typeof msg.payload.beforeBlockId === "string" && msg.payload.beforeBlockId.length > 0 ? msg.payload.beforeBlockId : undefined
        callbacks.onBlockAddRequested(nextSlug, { afterBlockId, beforeBlockId })
      }

      if (msg.type === "listItemAddRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const blockType = typeof msg.payload.blockType === "string" ? msg.payload.blockType : ""
        const listKey = typeof msg.payload.listKey === "string" ? msg.payload.listKey : ""
        const afterIndex = typeof msg.payload.afterIndex === "number" && Number.isInteger(msg.payload.afterIndex) ? msg.payload.afterIndex : undefined
        callbacks.onListItemAddRequested(nextSlug, blockId, blockType, listKey, afterIndex)
      }

      if (msg.type === "listItemRemoveRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const blockType = typeof msg.payload.blockType === "string" ? msg.payload.blockType : ""
        const listKey = typeof msg.payload.listKey === "string" ? msg.payload.listKey : ""
        const index = typeof msg.payload.index === "number" && Number.isInteger(msg.payload.index) ? msg.payload.index : -1
        callbacks.onListItemRemoveRequested(nextSlug, blockId, blockType, listKey, index)
      }

      if (msg.type === "listItemMoveRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const blockType = typeof msg.payload.blockType === "string" ? msg.payload.blockType : ""
        const listKey = typeof msg.payload.listKey === "string" ? msg.payload.listKey : ""
        const index = typeof msg.payload.index === "number" && Number.isInteger(msg.payload.index) ? msg.payload.index : -1
        const afterIndex = typeof msg.payload.afterIndex === "number" && Number.isInteger(msg.payload.afterIndex) ? msg.payload.afterIndex : undefined
        callbacks.onListItemMoveRequested(nextSlug, blockId, blockType, listKey, index, afterIndex)
      }

      if (msg.type === "inlineTextCommitted") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = typeof msg.payload.blockId === "string" ? msg.payload.blockId : ""
        const editablePath = typeof msg.payload.editablePath === "string" ? msg.payload.editablePath : ""
        const value = typeof msg.payload.value === "string" ? msg.payload.value : ""
        callbacks.onInlineTextCommitted(nextSlug, blockId, editablePath, value)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [slug, callbacks])

  return { iframeRef, postToSite, postPatchToSite }
}
