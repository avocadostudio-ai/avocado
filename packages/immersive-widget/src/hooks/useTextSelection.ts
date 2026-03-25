/**
 * Hook that detects text selection within editable block fields.
 * When the user selects text inside a [data-editable-target] element,
 * this hook provides the selection context for AI targeting.
 */

import { useState, useEffect, useCallback } from "react"

export type TextSelectionContext = {
  blockId: string
  blockType: string
  editablePath: string
  selectedText: string
  /** Bounding rect of the selection for positioning the toolbar */
  rect: DOMRect
}

export function useTextSelection() {
  const [textSelection, setTextSelection] = useState<TextSelectionContext | null>(null)

  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        setTextSelection(null)
        return
      }

      const text = selection.toString().trim()
      if (!text || text.length < 2) {
        setTextSelection(null)
        return
      }

      const range = selection.getRangeAt(0)
      const container = range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement

      if (!container) {
        setTextSelection(null)
        return
      }

      // Find the editable target ancestor
      const editableNode = container.closest<HTMLElement>("[data-editable-target]")
      if (!editableNode) {
        setTextSelection(null)
        return
      }

      // Find the block ancestor
      const blockNode = editableNode.closest<HTMLElement>("[data-block-id]")
      if (!blockNode) {
        setTextSelection(null)
        return
      }

      const blockId = blockNode.getAttribute("data-block-id") ?? ""
      const blockType = blockNode.getAttribute("data-block-type") ?? ""
      const editablePath = editableNode.getAttribute("data-editable-target") ?? ""

      if (!blockId || !editablePath) {
        setTextSelection(null)
        return
      }

      const rect = range.getBoundingClientRect()

      setTextSelection({
        blockId,
        blockType,
        editablePath,
        selectedText: text,
        rect,
      })
    }

    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [])

  const clearSelection = useCallback(() => {
    setTextSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  return { textSelection, clearSelection }
}
