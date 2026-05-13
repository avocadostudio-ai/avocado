import { useEffect, useRef } from "react"
import type { ApplyPatchMessage, Operation } from "@avocadostudio-ai/shared"
import type { SiteMessage } from "../lib/editor-types"
import { siteOrigin as defaultSiteOrigin } from "../lib/editor-utils"
import { parseOptionalString, parseString } from "../lib/parse-utils"

export type AnchorRect = { top: number; left: number; width: number; height: number } | null

export type PreviewBridgeCallbacks = {
  onBlockClicked: (slug: string, blockId: string | undefined, blockType: string | undefined, editablePath: string | undefined, editableValue: string | undefined, anchorRect: AnchorRect) => void
  onRouteChanged: (slug: string) => void
  onBlockReordered: (slug: string, blockId: string, afterBlockId: string | undefined) => void
  onBlockDeleteRequested: (slug: string, blockId: string) => void
  onBlockAddRequested: (slug: string, args: { afterBlockId?: string; beforeBlockId?: string }) => void
  onListItemAddRequested: (slug: string, blockId: string, blockType: string, listKey: string, afterIndex: number | undefined) => void
  onListItemRemoveRequested: (slug: string, blockId: string, blockType: string, listKey: string, index: number) => void
  onListItemMoveRequested: (slug: string, blockId: string, blockType: string, listKey: string, index: number, afterIndex: number | undefined) => void
  onInlineTextCommitted: (slug: string, blockId: string, editablePath: string, value: string) => void
  onOpenImagePicker: (slug: string, blockId: string, editablePath: string, currentUrl: string | undefined, blockType: string | undefined) => void
  onEditBlockRequested: (slug: string, blockId: string) => void
  onIframeScrolled?: () => void
}

export function usePreviewBridge(slug: string, callbacks: PreviewBridgeCallbacks, targetOrigin?: string) {
  const siteOrigin = targetOrigin || defaultSiteOrigin
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const lastConfirmedVersionBySlug = useRef<Map<string, number>>(new Map())
  const pendingTxBySlug = useRef<Map<string, { txId: string; timer: ReturnType<typeof setTimeout> }>>(new Map())

  const postToSite = (
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "navigate" | "aiFieldLoading" | "setSelectionMode" | "scrollToBlock",
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
        const nextBlockId = parseOptionalString(rawBlockId)
        const nextBlockType = parseOptionalString(rawBlockType)
        const nextPath = parseOptionalString(rawPath)
        const nextValue = parseOptionalString(msg.payload.editableValue)
        const rawRect = msg.payload.anchorRect
        let anchorRect: AnchorRect = null
        if (rawRect && typeof rawRect === "object" && "top" in rawRect) {
          const r = rawRect as Record<string, unknown>
          if (typeof r.top === "number" && typeof r.left === "number" && typeof r.width === "number" && typeof r.height === "number") {
            anchorRect = { top: r.top, left: r.left, width: r.width, height: r.height }
          }
        }
        callbacks.onBlockClicked(String(msg.payload.slug ?? "/"), nextBlockId, nextBlockType, nextPath, nextValue, anchorRect)
      }

      if (msg.type === "iframeScrolled") {
        callbacks.onIframeScrolled?.()
      }

      if (msg.type === "routeChanged") {
        callbacks.onRouteChanged(String(msg.payload.slug ?? "/"))
      }

      if (msg.type === "blockReordered") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const afterBlockId = parseOptionalString(msg.payload.afterBlockId)
        callbacks.onBlockReordered(nextSlug, blockId, afterBlockId)
      }

      if (msg.type === "blockDeleteRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        callbacks.onBlockDeleteRequested(nextSlug, blockId)
      }

      if (msg.type === "blockAddRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const afterBlockId = parseOptionalString(msg.payload.afterBlockId)
        const beforeBlockId = parseOptionalString(msg.payload.beforeBlockId)
        callbacks.onBlockAddRequested(nextSlug, { afterBlockId, beforeBlockId })
      }

      if (msg.type === "listItemAddRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const blockType = parseString(msg.payload.blockType, "")
        const listKey = parseString(msg.payload.listKey, "")
        const afterIndex = typeof msg.payload.afterIndex === "number" && Number.isInteger(msg.payload.afterIndex) ? msg.payload.afterIndex : undefined
        callbacks.onListItemAddRequested(nextSlug, blockId, blockType, listKey, afterIndex)
      }

      if (msg.type === "listItemRemoveRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const blockType = parseString(msg.payload.blockType, "")
        const listKey = parseString(msg.payload.listKey, "")
        const index = typeof msg.payload.index === "number" && Number.isInteger(msg.payload.index) ? msg.payload.index : -1
        callbacks.onListItemRemoveRequested(nextSlug, blockId, blockType, listKey, index)
      }

      if (msg.type === "listItemMoveRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const blockType = parseString(msg.payload.blockType, "")
        const listKey = parseString(msg.payload.listKey, "")
        const index = typeof msg.payload.index === "number" && Number.isInteger(msg.payload.index) ? msg.payload.index : -1
        const afterIndex = typeof msg.payload.afterIndex === "number" && Number.isInteger(msg.payload.afterIndex) ? msg.payload.afterIndex : undefined
        callbacks.onListItemMoveRequested(nextSlug, blockId, blockType, listKey, index, afterIndex)
      }

      if (msg.type === "editBlockRequested") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        callbacks.onEditBlockRequested(nextSlug, blockId)
      }

      if (msg.type === "openImagePicker") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const editablePath = parseString(msg.payload.editablePath, "")
        const currentUrl = parseOptionalString(msg.payload.currentUrl)
        const blockType = parseOptionalString(msg.payload.blockType)
        callbacks.onOpenImagePicker(nextSlug, blockId, editablePath, currentUrl, blockType)
      }

      if (msg.type === "inlineTextCommitted") {
        const nextSlug = String(msg.payload.slug ?? slug)
        const blockId = parseString(msg.payload.blockId, "")
        const editablePath = parseString(msg.payload.editablePath, "")
        const value = parseString(msg.payload.value, "")
        callbacks.onInlineTextCommitted(nextSlug, blockId, editablePath, value)
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [slug, callbacks, siteOrigin])

  return { iframeRef, postToSite, postPatchToSite }
}
