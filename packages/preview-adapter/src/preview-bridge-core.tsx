"use client"

import { useEffect, useRef } from "react"
import { isImagePath, type ApplyPatchMessage, type PatchAckMessage, type PatchRejectReason, type ResetToServerMessage } from "@ai-site-editor/shared"
import {
  createBridgeFunctions,
  createBridgeState,
  findBlockNode,
  findEditableNode,
  parseListItemPath,
  ensureBlockBadges,
  setNestedLabelsVisibility,
  showSkeleton,
  removeSkeletons,
  clearChildFocus,
  clearAllHighlights,
  applyAiFieldLoading,
  cleanupOverlayElements,
  type BridgeCallbacks,
  type BridgeState,
} from "./bridge-functions"

export type PreviewBridgeConfig = {
  navigate: (href: string) => void
  refresh: () => void
}

type SiteMessage =
  | {
      protocol: "site-editor/v1"
      type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "navigate" | "aiFieldLoading" | "setSelectionMode"
      payload: Record<string, unknown>
    }
  | ({ protocol: "site-editor/v1" } & ApplyPatchMessage)
  | ({ protocol: "site-editor/v1" } & ResetToServerMessage)

export type PreviewBridgeCoreProps = {
  slug: string
  editorOrigin: string
  navigate: (href: string) => void
  refresh: () => void
  pathname: string
}

export function PreviewBridgeCore(props: PreviewBridgeCoreProps) {
  // When running standalone (no editor origin) or not embedded in an iframe, render nothing.
  if (!props.editorOrigin || typeof window !== "undefined" && window.parent === window) return null

  return <PreviewBridgeCoreInner {...props} />
}

function PreviewBridgeCoreInner({ slug, editorOrigin, navigate, refresh, pathname }: PreviewBridgeCoreProps) {
  const stateRef = useRef<BridgeState | null>(null)

  useEffect(() => {
    // -- postMessage helpers ------------------------------------------------
    const postToEditor = (type: string, payload: Record<string, unknown>) => {
      window.parent.postMessage({ protocol: "site-editor/v1", type, payload }, editorOrigin)
    }

    const emitPatchAck = (txId: string, accepted: boolean, reason?: PatchRejectReason) => {
      const msg: PatchAckMessage = { type: "patchAck", txId, accepted, reason }
      window.parent.postMessage({ source: "site-editor/v1", ...msg }, editorOrigin)
    }

    // -- Bridge callbacks (postMessage transport) ---------------------------
    const callbacks: BridgeCallbacks = {
      onBlockClicked: (p) => postToEditor("blockClicked", p as unknown as Record<string, unknown>),
      onBlockDeleteRequested: (p) => postToEditor("blockDeleteRequested", p),
      onBlockReordered: (p) => postToEditor("blockReordered", p as unknown as Record<string, unknown>),
      onBlockAddRequested: (p) => postToEditor("blockAddRequested", p),
      onListItemRemoveRequested: (p) => postToEditor("listItemRemoveRequested", p),
      onListItemAddRequested: (p) => postToEditor("listItemAddRequested", p),
      onListItemMoveRequested: (p) => postToEditor("listItemMoveRequested", p as unknown as Record<string, unknown>),
      onInlineTextCommitted: (p) => postToEditor("inlineTextCommitted", p),
      onOpenImagePicker: (p) => postToEditor("openImagePicker", p as unknown as Record<string, unknown>),
      onScroll: () => postToEditor("iframeScrolled", {}),
    }

    // -- State & functions -------------------------------------------------
    const state = createBridgeState()
    stateRef.current = state

    const bridge = createBridgeFunctions(state, callbacks, { slug, pathname, refresh, navigate })

    // -- Initialization ----------------------------------------------------
    setNestedLabelsVisibility(false)
    document.documentElement.setAttribute("data-editor-active", "")

    // Restore selection mode if it was active before effect re-run
    if (state.selectionMode) {
      document.documentElement.setAttribute("data-editor-selection-mode", "")
    }

    ensureBlockBadges()
    bridge.mountGlobalImageButtons()

    // -- Mutation observer -------------------------------------------------
    let detectNewBlocksRaf: number | null = null
    const scheduleDetectNewBlocks = () => {
      if (detectNewBlocksRaf !== null) return
      detectNewBlocksRaf = requestAnimationFrame(() => {
        detectNewBlocksRaf = null
        bridge.detectNewBlocks()
      })
    }

    let imageButtonsRaf: number | null = null
    const scheduleImageButtons = () => {
      if (imageButtonsRaf !== null) return
      imageButtonsRaf = requestAnimationFrame(() => {
        imageButtonsRaf = null
        bridge.mountGlobalImageButtons()
      })
    }

    state.observer = new MutationObserver(() => {
      ensureBlockBadges()
      scheduleImageButtons()
      scheduleDetectNewBlocks()
    })
    if (document.body) state.observer.observe(document.body, { childList: true, subtree: true })

    // -- postMessage handler -----------------------------------------------
    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== editorOrigin) return
      const msg = event.data
      if (!msg || msg.protocol !== "site-editor/v1") return

      if (msg.type === "navigate") {
        const rawHref = String(msg.payload.href ?? "").trim()
        if (!rawHref) return
        const href = rawHref.startsWith("/") ? rawHref : `/${rawHref}`
        const currentHref = `${window.location.pathname}${window.location.search}`
        if (href === currentHref) return
        navigate(href)
        return
      }

      if (msg.type === "setSelectionMode") {
        const enabled = !!msg.payload.enabled
        state.selectionMode = enabled
        if (enabled) {
          document.documentElement.setAttribute("data-editor-selection-mode", "")
          bridge.mountGlobalImageButtons()
        } else {
          document.documentElement.removeAttribute("data-editor-selection-mode")
          document.querySelectorAll(".editor-image-change-btn").forEach((el) => el.remove())
        }
        return
      }

      if (msg.type === "applyPatch") {
        if (state.serverVersion !== msg.fromVersion) {
          emitPatchAck(msg.txId, false, "version_mismatch")
          return
        }
        state.serverVersion = msg.toVersion
        if (msg.focusBlockId) {
          state.pendingFocusId = msg.focusBlockId
          state.pendingScrollIntoView = state.pendingScrollIntoView && msg.op?.op === "move_block"
        }
        if (msg.op?.op === "move_item") {
          state.skipParentAnimationOnce = true
        }
        state.expectingNewBlocks = msg.op?.op === "add_block"
        bridge.smoothRefresh()
        emitPatchAck(msg.txId, true)
        return
      }

      if (msg.type === "resetToServer") {
        state.serverVersion = msg.toVersion
        state.expectingNewBlocks = true
        if (msg.focusBlockId) {
          state.pendingFocusId = msg.focusBlockId
          state.pendingScrollIntoView = false
        }
        state.pendingListItemMovePath = null
        bridge.setChildSelectionLock(null)
        bridge.smoothRefresh(true)
        return
      }

      if (msg.type === "draftUpdated") {
        const focusBlockId = String(msg.payload.focusBlockId ?? "")
        state.pendingFocusId = focusBlockId || null
        state.expectingNewBlocks = true
        bridge.clearLiveDraft()
        clearChildFocus()
        state.selectedEditablePath = null
        state.pendingListItemMovePath = null
        bridge.setChildSelectionLock(null)
        const navigateTo = typeof msg.payload.navigateTo === "string" ? msg.payload.navigateTo.trim() : ""
        if (navigateTo) {
          const href = navigateTo.startsWith("/") ? navigateTo : `/${navigateTo}`
          navigate(`${href}${window.location.search}`)
        } else {
          bridge.smoothRefresh()
        }
      }

      if (msg.type === "highlightBlock") {
        const blockId = String(msg.payload.blockId ?? "")
        let editablePath = String(msg.payload.editablePath ?? "") || undefined
        if (!editablePath && state.pendingListItemMovePath && state.selectedBlockId === blockId) {
          editablePath = state.pendingListItemMovePath
        }
        if (!editablePath) {
          state.selectedEditablePath = null
          state.pendingListItemMovePath = null
          bridge.setChildSelectionLock(null)
        } else if (state.pendingListItemMovePath === editablePath) {
          state.pendingListItemMovePath = null
          const parsed = parseListItemPath(editablePath)
          if (parsed) {
            const existing = state.childSelectionLock
            const position =
              existing && existing.blockId === blockId && existing.listKey === parsed.listKey
                ? existing.position
                : undefined
            bridge.setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index, position })
          }
        } else {
          const parsed = parseListItemPath(editablePath)
          if (parsed) {
            const existing = state.childSelectionLock
            const position =
              existing && existing.blockId === blockId && existing.listKey === parsed.listKey
                ? existing.position
                : undefined
            bridge.setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index, position })
          } else {
            bridge.setChildSelectionLock(null)
          }
        }
        bridge.applyBlockFocus(blockId, false, editablePath)
      }

      if (msg.type === "setNestedLabelsVisibility") {
        setNestedLabelsVisibility(Boolean(msg.payload.visible))
      }

      if (msg.type === "liveDraft") {
        const blockId = String(msg.payload.blockId ?? "")
        const text = String(msg.payload.text ?? "")
        const active = Boolean(msg.payload.active)
        const fields = (msg.payload.fields && typeof msg.payload.fields === "object")
          ? msg.payload.fields as Record<string, string>
          : undefined
        bridge.renderLiveDraft(blockId, text, active, fields)
      }

      if (msg.type === "showSkeleton") {
        const afterBlockId = msg.payload.afterBlockId ? String(msg.payload.afterBlockId) : null
        const blockType = String(msg.payload.blockType ?? "Block")
        showSkeleton(afterBlockId, blockType)
      }

      if (msg.type === "removeSkeleton") {
        removeSkeletons()
      }

      if (msg.type === "aiFieldLoading") {
        const blockId = String(msg.payload.blockId ?? "")
        const editablePath = String(msg.payload.editablePath ?? "")
        const active = Boolean(msg.payload.active)
        state.activeShimmer = active ? { blockId, editablePath } : null
        applyAiFieldLoading(blockId, editablePath, active)
      }
    }

    // -- Scroll handler ----------------------------------------------------
    const onScroll = () => {
      callbacks.onScroll()
    }

    // -- Attach event listeners --------------------------------------------
    document.addEventListener("click", bridge.onClick, true)
    document.addEventListener("dblclick", bridge.onDoubleClick, true)
    document.addEventListener("pointermove", bridge.onPointerMove, true)
    document.addEventListener("keydown", bridge.onKeyDown, true)
    window.addEventListener("message", onMessage)
    window.addEventListener("scroll", onScroll, { passive: true })

    // -- Cleanup -----------------------------------------------------------
    return () => {
      if (detectNewBlocksRaf !== null) cancelAnimationFrame(detectNewBlocksRaf)
      if (imageButtonsRaf !== null) cancelAnimationFrame(imageButtonsRaf)
      bridge.cancelInlineEdit()
      clearChildFocus()
      bridge.restoreLiveDraftOriginals()
      bridge.clearLiveDraft()
      bridge.removeSelectedDeleteHandle()
      state.observer?.disconnect()
      document.removeEventListener("click", bridge.onClick, true)
      document.removeEventListener("dblclick", bridge.onDoubleClick, true)
      document.removeEventListener("pointermove", bridge.onPointerMove, true)
      document.removeEventListener("keydown", bridge.onKeyDown, true)
      window.removeEventListener("message", onMessage)
      window.removeEventListener("scroll", onScroll)
      cleanupOverlayElements()
    }
  }, [editorOrigin, navigate, refresh, slug])

  useEffect(() => {
    window.parent.postMessage(
      {
        protocol: "site-editor/v1",
        type: "routeChanged",
        payload: { slug: pathname || "/" }
      },
      editorOrigin
    )
  }, [editorOrigin, pathname])

  // Track placeholder→real image swaps for blur→sharp reveal animation
  const placeholderBlockIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const PLACEHOLDER_PREFIX = "data:image/svg+xml"

    function scanForPlaceholders() {
      document.querySelectorAll<HTMLElement>(".hero__media img").forEach((img) => {
        const src = img.getAttribute("src") ?? ""
        const blockEl = img.closest<HTMLElement>("[data-block-id]")
        if (!blockEl) return
        const blockId = blockEl.getAttribute("data-block-id") ?? ""
        if (src.startsWith(PLACEHOLDER_PREFIX)) {
          placeholderBlockIdsRef.current.add(blockId)
        }
      })
    }

    function applyReveal(img: HTMLImageElement) {
      const doReveal = () => {
        img.classList.add("ai-image-reveal")
        img.addEventListener("animationend", () => img.classList.remove("ai-image-reveal"), { once: true })
      }
      if (img.complete && img.naturalWidth > 0) doReveal()
      else img.addEventListener("load", doReveal, { once: true })
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          const imgs = node.matches?.(".hero__media img")
            ? [node as HTMLImageElement]
            : Array.from(node.querySelectorAll<HTMLImageElement>(".hero__media img"))
          for (const img of imgs) {
            const src = img.getAttribute("src") ?? ""
            const blockEl = img.closest<HTMLElement>("[data-block-id]")
            if (!blockEl) continue
            const blockId = blockEl.getAttribute("data-block-id") ?? ""
            if (src.startsWith(PLACEHOLDER_PREFIX)) {
              placeholderBlockIdsRef.current.add(blockId)
            } else if (src.startsWith("http") && placeholderBlockIdsRef.current.has(blockId)) {
              placeholderBlockIdsRef.current.delete(blockId)
              applyReveal(img)
            }
          }
        }
      }
    })

    observer.observe(document.body, { childList: true, subtree: true })
    scanForPlaceholders()
    return () => observer.disconnect()
  }, [])

  return null
}
