/**
 * Hook that manages block selection in immersive mode.
 * Uses the extracted bridge functions directly — no postMessage.
 */

import { useEffect, useRef, useCallback } from "react"
import {
  createBridgeFunctions,
  createBridgeState,
  ensureBlockBadges,
  setNestedLabelsVisibility,
  clearChildFocus,
  cleanupOverlayElements,
  type BridgeCallbacks,
  type BridgeState,
  type BridgeFunctions,
} from "@ai-site-editor/preview-adapter"

export type BlockSelectionState = {
  blockId: string | null
  blockType: string | null
  editablePath: string | null
}

type UseBlockSelectionArgs = {
  slug: string
  pathname: string
  refresh: () => void
  navigate: (href: string) => void
  selectionMode: boolean
  onBlockSelected?: (state: BlockSelectionState) => void
  onInlineTextCommitted?: (payload: { slug: string; blockId: string; blockType: string; editablePath: string; value: string }) => void
  onBlockDeleteRequested?: (payload: { slug: string; blockId: string; blockType: string }) => void
  onBlockReordered?: (payload: { slug: string; blockId: string; afterBlockId: string | null }) => void
  onBlockAddRequested?: (payload: { slug: string; afterBlockId?: string; beforeBlockId?: string }) => void
  onListItemRemoveRequested?: (payload: { slug: string; blockId: string; blockType: string; listKey: string; index: number }) => void
  onListItemAddRequested?: (payload: { slug: string; blockId: string; blockType: string; listKey: string; afterIndex: number }) => void
  onListItemMoveRequested?: (payload: { slug: string; blockId: string; blockType: string; listKey: string; index: number; afterIndex?: number }) => void
  onOpenImagePicker?: (payload: { slug: string; blockId: string; editablePath: string; currentUrl?: string }) => void
}

export function useBlockSelection(args: UseBlockSelectionArgs) {
  const stateRef = useRef<BridgeState | null>(null)
  const bridgeRef = useRef<BridgeFunctions | null>(null)

  const {
    slug, pathname, refresh, navigate, selectionMode,
    onBlockSelected, onInlineTextCommitted, onBlockDeleteRequested,
    onBlockReordered, onBlockAddRequested, onListItemRemoveRequested,
    onListItemAddRequested, onListItemMoveRequested, onOpenImagePicker,
  } = args

  // Store latest callbacks in refs to avoid re-creating bridge on every render
  const callbackRefs = useRef(args)
  callbackRefs.current = args

  useEffect(() => {
    const callbacks: BridgeCallbacks = {
      onBlockClicked: (p) => {
        callbackRefs.current.onBlockSelected?.({
          blockId: p.blockId,
          blockType: p.blockType,
          editablePath: p.editablePath,
        })
      },
      onBlockDeleteRequested: (p) => callbackRefs.current.onBlockDeleteRequested?.(p),
      onBlockReordered: (p) => callbackRefs.current.onBlockReordered?.(p),
      onBlockAddRequested: (p) => callbackRefs.current.onBlockAddRequested?.(p),
      onListItemRemoveRequested: (p) => callbackRefs.current.onListItemRemoveRequested?.(p),
      onListItemAddRequested: (p) => callbackRefs.current.onListItemAddRequested?.(p),
      onListItemMoveRequested: (p) => callbackRefs.current.onListItemMoveRequested?.(p),
      onInlineTextCommitted: (p) => callbackRefs.current.onInlineTextCommitted?.(p),
      onOpenImagePicker: (p) => callbackRefs.current.onOpenImagePicker?.(p),
      onScroll: () => {}, // No-op in immersive mode (no parent iframe to notify)
    }

    const state = createBridgeState()
    stateRef.current = state

    const bridge = createBridgeFunctions(state, callbacks, { slug, pathname, refresh, navigate })
    bridgeRef.current = bridge

    // Initialize editor overlay
    document.documentElement.setAttribute("data-editor-active", "")
    setNestedLabelsVisibility(false)

    if (selectionMode) {
      document.documentElement.setAttribute("data-editor-selection-mode", "")
      state.selectionMode = true
    }

    ensureBlockBadges()
    bridge.mountGlobalImageButtons()

    // Mutation observer
    let detectNewBlocksRaf: number | null = null
    let imageButtonsRaf: number | null = null

    state.observer = new MutationObserver(() => {
      ensureBlockBadges()
      if (imageButtonsRaf === null) {
        imageButtonsRaf = requestAnimationFrame(() => {
          imageButtonsRaf = null
          bridge.mountGlobalImageButtons()
        })
      }
      if (detectNewBlocksRaf === null) {
        detectNewBlocksRaf = requestAnimationFrame(() => {
          detectNewBlocksRaf = null
          bridge.detectNewBlocks()
        })
      }
    })
    if (document.body) state.observer.observe(document.body, { childList: true, subtree: true })

    // Attach event listeners
    document.addEventListener("click", bridge.onClick, true)
    document.addEventListener("dblclick", bridge.onDoubleClick, true)
    document.addEventListener("pointermove", bridge.onPointerMove, true)
    document.addEventListener("keydown", bridge.onKeyDown, true)

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
      cleanupOverlayElements()
    }
  }, [slug, pathname, refresh, navigate, selectionMode])

  const focusBlock = useCallback((blockId: string) => {
    bridgeRef.current?.applyBlockFocus(blockId, true)
  }, [])

  const renderLiveDraft = useCallback((blockId: string, text: string, active: boolean, fields?: Record<string, string>) => {
    bridgeRef.current?.renderLiveDraft(blockId, text, active, fields)
  }, [])

  const triggerRefresh = useCallback((focusBlockId?: string) => {
    const state = stateRef.current
    if (state && focusBlockId) {
      state.pendingFocusId = focusBlockId
      state.expectingNewBlocks = true
    }
    bridgeRef.current?.smoothRefresh()
  }, [])

  return { focusBlock, renderLiveDraft, triggerRefresh, stateRef, bridgeRef }
}
