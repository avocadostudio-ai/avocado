"use client"

import { useEffect, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"

// site-editor/v2 patch transport message types (mirrored from @ai-site-editor/shared)
type PatchRejectReason = "version_mismatch" | "apply_error" | "unknown_op"

type ApplyPatchMessage = {
  type: "applyPatch"
  txId: string
  op: Record<string, unknown>
  fromVersion: number
  toVersion: number
  focusBlockId?: string
}

type PatchAckMessage = {
  type: "patchAck"
  txId: string
  accepted: boolean
  reason?: PatchRejectReason
}

type ResetToServerMessage = {
  type: "resetToServer"
  toVersion: number
  focusBlockId?: string
}

type SiteMessage =
  | {
      protocol: "site-editor/v1"
      type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft"
      payload: Record<string, unknown>
    }
  | ({ protocol: "site-editor/v1" } & ApplyPatchMessage)
  | ({ protocol: "site-editor/v1" } & ResetToServerMessage)

export function PreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const pendingFocusRef = useRef<string | null>(null)
  const pendingScrollIntoViewRef = useRef(false)
  const pendingScrollRestoreRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickUntilRef = useRef(0)
  const selectedBlockRef = useRef<string | null>(null)
  const selectedEditablePathRef = useRef<string | null>(null)
  const deleteConfirmTimerRef = useRef<number | null>(null)
  const inlineEditingRef = useRef<{
    node: HTMLElement
    blockId: string
    blockType: string
    editablePath: string
    initialValue: string
    isMultiline: boolean
  } | null>(null)

  const serverVersionRef = useRef<number>(0)

  useEffect(() => {
    const emitPatchAck = (txId: string, accepted: boolean, reason?: PatchRejectReason) => {
      const msg: PatchAckMessage = { type: "patchAck", txId, accepted, reason }
      window.parent.postMessage({ source: "site-editor/v1", ...msg }, editorOrigin)
    }

    const setNestedLabelsVisibility = (visible: boolean) => {
      document.documentElement.classList.toggle("editor-hide-nested-labels", !visible)
    }
    // Keep nested labels hidden by default until the editor explicitly enables them.
    setNestedLabelsVisibility(false)

    const clearChildFocus = () => {
      document.querySelectorAll(".editor-child-highlight").forEach((node) => node.classList.remove("editor-child-highlight"))
    }

    let liveDraftActiveBlockId: string | null = null
    let liveDraftBadgeTimer: number | null = null

    const clearLiveDraftBadgeTimer = () => {
      if (liveDraftBadgeTimer === null) return
      window.clearTimeout(liveDraftBadgeTimer)
      liveDraftBadgeTimer = null
    }

    const clearLiveDraft = () => {
      clearLiveDraftBadgeTimer()
      document.querySelectorAll(".editor-live-draft").forEach((node) => node.remove())
      document.querySelectorAll(".editor-live-draft-active").forEach((node) => node.classList.remove("editor-live-draft-active"))
      document.querySelectorAll(".editor-block-badge-status").forEach((node) => node.remove())
      liveDraftActiveBlockId = null
    }

    const findBlockNode = (blockId: string) => {
      if (!blockId) return null
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        return document.querySelector<HTMLElement>(`[data-block-id='${CSS.escape(blockId)}']`)
      }
      return document.querySelector<HTMLElement>(`[data-block-id='${blockId}']`)
    }

    const setLiveDraftBadge = (block: HTMLElement, active: boolean) => {
      clearLiveDraftBadgeTimer()
      const badge = block.querySelector<HTMLElement>(".editor-block-badge")
      if (!badge) return
      badge.querySelectorAll(".editor-block-badge-status").forEach((node) => node.remove())
      if (!active) return
      // Avoid flicker for very fast runs; show only if drafting remains active.
      liveDraftBadgeTimer = window.setTimeout(() => {
        if (!block.classList.contains("editor-live-draft-active")) return
        const status = document.createElement("span")
        status.className = "editor-block-badge-status"
        status.textContent = "Updating"
        badge.append(status)
      }, 1200)
    }

    const renderLiveDraft = (blockId: string, text: string, active: boolean) => {
      if (!active) {
        clearLiveDraft()
        return
      }
      const trimmed = text.trim()
      if (!blockId || !trimmed) {
        clearLiveDraft()
        return
      }
      if (liveDraftActiveBlockId === blockId) return
      clearLiveDraft()
      const block = findBlockNode(blockId)
      if (!block) return
      block.classList.add("editor-live-draft-active")
      liveDraftActiveBlockId = blockId
      setLiveDraftBadge(block, true)
    }

    const findEditableNode = (parent: HTMLElement, editablePath: string) => {
      const nodes = parent.querySelectorAll<HTMLElement>("[data-editable-target]")
      for (const node of nodes) {
        if ((node.getAttribute("data-editable-target") ?? "") === editablePath) return node
      }
      return null
    }

    const parseListItemPath = (editablePath?: string | null) => {
      const path = String(editablePath ?? "")
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\](?:\.|$)/.exec(path)
      if (!match) return null
      return { listKey: match[1], index: Number(match[2]) }
    }

    const clearListItemSelection = (scope?: ParentNode) => {
      ;(scope ?? document).querySelectorAll(".editor-item-selected").forEach((node) => node.classList.remove("editor-item-selected"))
      ;(scope ?? document)
        .querySelectorAll(".editor-child-selected")
        .forEach((node) => node.classList.remove("editor-child-selected"))
    }

    const applyListItemSelection = (block: HTMLElement, editablePath?: string | null) => {
      clearListItemSelection(block)
      const parsed = parseListItemPath(editablePath)
      if (!parsed) return false
      const itemRoot = block.querySelector<HTMLElement>(
        `.editor-item-has-delete[data-editor-list-key="${parsed.listKey}"][data-editor-list-index="${parsed.index}"]`
      )
      if (!itemRoot) return false
      itemRoot.classList.add("editor-item-selected")
      block.classList.add("editor-child-selected")
      return true
    }

    let hoveredItemRoot: HTMLElement | null = null
    let hoveredBlockRoot: HTMLElement | null = null
    const setHoveredListItem = (next: HTMLElement | null) => {
      if (hoveredItemRoot === next) return
      if (hoveredItemRoot) hoveredItemRoot.classList.remove("editor-item-hover")
      if (hoveredBlockRoot) hoveredBlockRoot.classList.remove("editor-child-hovering")
      hoveredItemRoot = next
      hoveredBlockRoot = null
      if (!next) return
      next.classList.add("editor-item-hover")
      const block = next.closest<HTMLElement>(".editor-highlight")
      if (!block) return
      block.classList.add("editor-child-hovering")
      hoveredBlockRoot = block
    }

    const applyChildFocus = (parentBlockId: string, editablePath?: string) => {
      clearChildFocus()
      selectedBlockRef.current = parentBlockId
      selectedEditablePathRef.current = editablePath ?? null
      if (!editablePath) return
      const parent = findBlockNode(parentBlockId)
      if (!parent) return
      const child = findEditableNode(parent, editablePath)
      if (!child) return
      child.classList.add("editor-child-highlight")
    }

    const supportsInlineEditablePath = (editablePath: string) => {
      if (!editablePath) return false
      if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+\]\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(editablePath)) return false
      if (/(^|\.)(?:ctaHref|secondaryCtaHref|imageUrl|imageAlt|href|url)$/i.test(editablePath)) return false
      return true
    }

    const readNodeText = (node: HTMLElement) => node.innerText.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ")

    const placeCaretAtEnd = (node: HTMLElement) => {
      const selection = window.getSelection?.()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(node)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    const cancelInlineEdit = () => {
      const state = inlineEditingRef.current
      if (!state) return
      state.node.textContent = state.initialValue
      state.node.setAttribute("contenteditable", "false")
      state.node.classList.remove("editor-inline-editing")
      inlineEditingRef.current = null
    }

    const commitInlineEdit = () => {
      const state = inlineEditingRef.current
      if (!state) return

      state.node.setAttribute("contenteditable", "false")
      state.node.classList.remove("editor-inline-editing")
      inlineEditingRef.current = null

      const nextValue = readNodeText(state.node)
      if (nextValue === state.initialValue) return

      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "inlineTextCommitted",
          payload: {
            slug,
            blockId: state.blockId,
            blockType: state.blockType,
            editablePath: state.editablePath,
            value: nextValue
          }
        },
        editorOrigin
      )
    }

    const startInlineEdit = (args: { node: HTMLElement; blockId: string; blockType: string; editablePath: string }) => {
      if (!supportsInlineEditablePath(args.editablePath)) return
      // Avoid mutating React-managed rich text structures (lists/headings/paragraph trees).
      // contenteditable on container nodes with element children can cause reconciliation crashes.
      if (args.node.children.length > 0) return
      const existing = inlineEditingRef.current
      if (existing?.node === args.node) return
      if (existing) commitInlineEdit()

      const initialValue = readNodeText(args.node)
      inlineEditingRef.current = {
        node: args.node,
        blockId: args.blockId,
        blockType: args.blockType,
        editablePath: args.editablePath,
        initialValue,
        isMultiline: args.editablePath === "body"
      }
      args.node.setAttribute("contenteditable", "true")
      args.node.classList.add("editor-inline-editing")
      args.node.focus()
      placeCaretAtEnd(args.node)
    }

    const removeSelectedDeleteHandle = () => {
      setHoveredListItem(null)
      document.querySelectorAll(".editor-block-toolbar").forEach((node) => node.remove())
      document.querySelectorAll(".editor-selected-delete").forEach((node) => node.remove())
      document.querySelectorAll(".editor-selected-move").forEach((node) => node.remove())
      document.querySelectorAll(".editor-selected-add").forEach((node) => node.remove())
      document.querySelectorAll(".editor-list-item-controls").forEach((node) => node.remove())
      document.querySelectorAll(".editor-list-item-delete").forEach((node) => node.remove())
      document.querySelectorAll(".editor-list-item-add").forEach((node) => node.remove())
      document.querySelectorAll(".editor-list-item-move").forEach((node) => node.remove())
      document.querySelectorAll(".editor-item-has-delete").forEach((node) => node.classList.remove("editor-item-has-delete"))
      clearListItemSelection()
      document.querySelectorAll(".editor-delete-confirm").forEach((node) => node.remove())
      if (deleteConfirmTimerRef.current) {
        window.clearTimeout(deleteConfirmTimerRef.current)
        deleteConfirmTimerRef.current = null
      }
    }

    const mountSelectedDeleteHandle = () => {
      const selected = document.querySelector<HTMLElement>(".editor-highlight[data-block-id]")
      if (!selected) return
      const blockId = selected.getAttribute("data-block-id")
      const blockType = selected.getAttribute("data-block-type") ?? "Block"
      if (!blockId) return

      const del = document.createElement("button")
      del.type = "button"
      del.className = "editor-selected-delete"
      del.draggable = false
      del.setAttribute("aria-label", `Delete ${blockType}`)
      del.title = `Delete ${blockType}`
      del.innerHTML =
        '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 3h7"/><path d="M4.5 3V2h3v1"/><path d="M3.5 3h5l-.4 6.2a.8.8 0 0 1-.8.8H4.7a.8.8 0 0 1-.8-.8z"/></svg>'
      del.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()

        // If confirm popover already showing, dismiss it
        const existing = selected.querySelector(".editor-delete-confirm")
        if (existing) {
          existing.remove()
          if (deleteConfirmTimerRef.current) {
            window.clearTimeout(deleteConfirmTimerRef.current)
            deleteConfirmTimerRef.current = null
          }
          return
        }

        // Show confirmation popover
        const popover = document.createElement("div")
        popover.className = "editor-delete-confirm"
        const label = document.createElement("span")
        label.textContent = "Delete block?"
        const confirmBtn = document.createElement("button")
        confirmBtn.type = "button"
        confirmBtn.className = "editor-delete-confirm-btn"
        confirmBtn.textContent = "Confirm"
        confirmBtn.addEventListener("click", (e) => {
          e.preventDefault()
          e.stopPropagation()
          popover.remove()
          if (deleteConfirmTimerRef.current) {
            window.clearTimeout(deleteConfirmTimerRef.current)
            deleteConfirmTimerRef.current = null
          }
          window.parent.postMessage(
            { protocol: "site-editor/v1", type: "blockDeleteRequested", payload: { slug, blockId, blockType } },
            editorOrigin
          )
        })
        popover.append(label, confirmBtn)
        selected.prepend(popover)
        deleteConfirmTimerRef.current = window.setTimeout(() => {
          popover.remove()
          deleteConfirmTimerRef.current = null
        }, 4000)
      })

      const toolbar = selected.querySelector(".editor-block-toolbar")
      if (toolbar) {
        toolbar.append(del)
      } else {
        selected.prepend(del)
      }
    }

    const blockOrder = () =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
        .map((node) => node.getAttribute("data-block-id"))
        .filter((id): id is string => Boolean(id && id.length > 0))

    const computeMoveAfter = (blockId: string, direction: "up" | "down") => {
      const order = blockOrder()
      const idx = order.findIndex((id) => id === blockId)
      if (idx === -1) return { canMove: false, afterBlockId: null as string | null }
      if (direction === "up") {
        if (idx === 0) return { canMove: false, afterBlockId: null as string | null }
        return { canMove: true, afterBlockId: idx - 2 >= 0 ? order[idx - 2] : null }
      }
      if (idx >= order.length - 1) return { canMove: false, afterBlockId: null as string | null }
      return { canMove: true, afterBlockId: order[idx + 1] ?? null }
    }

    const computeInsertBefore = (blockId: string) => {
      const order = blockOrder()
      const idx = order.findIndex((id) => id === blockId)
      if (idx <= 0) return { afterBlockId: null as string | null, beforeBlockId: blockId }
      return { afterBlockId: order[idx - 1] ?? null, beforeBlockId: blockId }
    }

    const groupListItemNodes = (block: HTMLElement) => {
      const groups = new Map<string, { listKey: string; index: number; nodes: HTMLElement[] }>()
      block.querySelectorAll<HTMLElement>("[data-editable-target]").forEach((node) => {
        const path = String(node.getAttribute("data-editable-target") ?? "")
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\](?:\.|$)/.exec(path)
        if (!match) return
        const listKey = match[1]
        const index = Number(match[2])
        const key = `${listKey}:${index}`
        const existing = groups.get(key)
        if (existing) {
          existing.nodes.push(node)
        } else {
          groups.set(key, { listKey, index, nodes: [node] })
        }
      })
      return [...groups.values()]
    }

    const commonItemRoot = (block: HTMLElement, nodes: HTMLElement[]) => {
      if (nodes.length === 0) return null
      let candidate: HTMLElement | null = nodes[0]
      while (candidate && !nodes.every((node) => candidate?.contains(node))) {
        candidate = candidate.parentElement
      }
      if (!candidate || candidate === block) return null
      if (!block.contains(candidate)) return null
      return candidate
    }

    const mountListItemDeleteHandles = (block: HTMLElement, blockId: string) => {
      const blockType = block.getAttribute("data-block-type") ?? "Block"
      const groups = groupListItemNodes(block)
      if (groups.length === 0) return

      const resolved = groups
        .map((group) => ({ ...group, root: commonItemRoot(block, group.nodes) }))
        .filter((group): group is { listKey: string; index: number; nodes: HTMLElement[]; root: HTMLElement } => Boolean(group.root))
      if (resolved.length === 0) return

      const perListCounts = new Map<string, number>()
      const lastByList = new Map<string, { listKey: string; index: number; root: HTMLElement }>()
      const sortedIndicesByList = new Map<string, number[]>()
      const rootByListAndIndex = new Map<string, Map<number, HTMLElement>>()
      for (const group of resolved) {
        perListCounts.set(group.listKey, (perListCounts.get(group.listKey) ?? 0) + 1)
        const currentLast = lastByList.get(group.listKey)
        if (!currentLast || group.index > currentLast.index) {
          lastByList.set(group.listKey, { listKey: group.listKey, index: group.index, root: group.root })
        }
        if (!sortedIndicesByList.has(group.listKey)) sortedIndicesByList.set(group.listKey, [])
        sortedIndicesByList.get(group.listKey)?.push(group.index)
        if (!rootByListAndIndex.has(group.listKey)) rootByListAndIndex.set(group.listKey, new Map())
        rootByListAndIndex.get(group.listKey)?.set(group.index, group.root)
      }
      for (const [key, indices] of sortedIndicesByList.entries()) {
        sortedIndicesByList.set(key, [...new Set(indices)].sort((a, b) => a - b))
      }
      const horizontalByList = new Map<string, boolean>()
      for (const [listKey, order] of sortedIndicesByList.entries()) {
        if (order.length < 2) {
          horizontalByList.set(listKey, false)
          continue
        }
        const roots = rootByListAndIndex.get(listKey)
        const first = roots?.get(order[0]!)
        const second = roots?.get(order[1]!)
        if (!first || !second) {
          horizontalByList.set(listKey, false)
          continue
        }
        const a = first.getBoundingClientRect()
        const b = second.getBoundingClientRect()
        const dx = Math.abs(b.left - a.left)
        const dy = Math.abs(b.top - a.top)
        horizontalByList.set(listKey, dx > dy)
      }

      const normalizedAfterIndex = (index: number, afterIndex: number | undefined) => {
        if (typeof afterIndex !== "number") return undefined
        return afterIndex > index ? afterIndex - 1 : afterIndex
      }

      for (const group of resolved) {
        const root = group.root
        if (root.querySelector(".editor-list-item-delete")) continue
        root.classList.add("editor-item-has-delete")
        root.setAttribute("data-editor-list-key", group.listKey)
        root.setAttribute("data-editor-list-index", String(group.index))
        const controls = document.createElement("div")
        controls.className = "editor-list-item-controls"

        const del = document.createElement("button")
        del.type = "button"
        del.className = "editor-list-item-delete"
        del.setAttribute("aria-label", `Delete ${group.listKey} item`)
        del.title = "Delete item"
        del.innerHTML =
          '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 3h7"/><path d="M4.5 3V2h3v1"/><path d="M3.5 3h5l-.4 6.2a.8.8 0 0 1-.8.8H4.7a.8.8 0 0 1-.8-.8z"/></svg>'
        del.disabled = (perListCounts.get(group.listKey) ?? 0) <= 1
        del.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (del.disabled) return
          window.parent.postMessage(
            {
              protocol: "site-editor/v1",
              type: "listItemRemoveRequested",
              payload: { slug, blockId, blockType, listKey: group.listKey, index: group.index }
            },
            editorOrigin
          )
        })
        const order = sortedIndicesByList.get(group.listKey) ?? []
        const pos = order.findIndex((idx) => idx === group.index)
        const canMoveUp = pos > 0
        const canMoveDown = pos >= 0 && pos < order.length - 1
        const upAfterIndex = pos - 2 >= 0 ? order[pos - 2] : undefined
        const downAfterIndex = canMoveDown ? normalizedAfterIndex(group.index, order[pos + 1]) : undefined
        const useHorizontalArrows = horizontalByList.get(group.listKey) === true
        const showHorizontalUp = useHorizontalArrows
        const showHorizontalDown = useHorizontalArrows
        const upIcon = showHorizontalUp
          ? '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M10 6H2"/><path d="M5.5 2.5L2 6l3.5 3.5"/></svg>'
          : '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 10V2"/><path d="M2.5 5.5L6 2l3.5 3.5"/></svg>'
        const downIcon = showHorizontalDown
          ? '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2 6h8"/><path d="M6.5 2.5L10 6l-3.5 3.5"/></svg>'
          : '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2v8"/><path d="M2.5 6.5L6 10l3.5-3.5"/></svg>'

        const moveUp = document.createElement("button")
        moveUp.type = "button"
        moveUp.className = "editor-list-item-move editor-list-item-move-up"
        moveUp.setAttribute("aria-label", `Move ${group.listKey} item ${showHorizontalUp ? "left" : "up"}`)
        moveUp.title = showHorizontalUp ? "Move item left" : "Move item up"
        moveUp.innerHTML = upIcon
        moveUp.disabled = !canMoveUp
        moveUp.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!canMoveUp) return
          window.parent.postMessage(
            {
              protocol: "site-editor/v1",
              type: "listItemMoveRequested",
              payload: {
                slug,
                blockId,
                blockType,
                listKey: group.listKey,
                index: group.index,
                afterIndex: upAfterIndex
              }
            },
            editorOrigin
          )
        })
        controls.append(moveUp)

        const moveDown = document.createElement("button")
        moveDown.type = "button"
        moveDown.className = "editor-list-item-move editor-list-item-move-down"
        moveDown.setAttribute("aria-label", `Move ${group.listKey} item ${showHorizontalDown ? "right" : "down"}`)
        moveDown.title = showHorizontalDown ? "Move item right" : "Move item down"
        moveDown.innerHTML = downIcon
        moveDown.disabled = !canMoveDown
        moveDown.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (!canMoveDown || typeof downAfterIndex !== "number") return
          window.parent.postMessage(
            {
              protocol: "site-editor/v1",
              type: "listItemMoveRequested",
              payload: {
                slug,
                blockId,
                blockType,
                listKey: group.listKey,
                index: group.index,
                afterIndex: downAfterIndex
              }
            },
            editorOrigin
          )
        })
        controls.append(moveDown)
        controls.append(del)
        root.append(controls)
      }

      for (const entry of lastByList.values()) {
        if (entry.root.querySelector(".editor-list-item-add")) continue
        const add = document.createElement("button")
        add.type = "button"
        add.className = "editor-list-item-add"
        add.setAttribute("aria-label", `Add ${entry.listKey} item`)
        add.title = "Add item"
        add.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2v8"/><path d="M2 6h8"/></svg>'
        add.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          window.parent.postMessage(
            {
              protocol: "site-editor/v1",
              type: "listItemAddRequested",
              payload: { slug, blockId, blockType, listKey: entry.listKey, afterIndex: entry.index }
            },
            editorOrigin
          )
        })
        entry.root.append(add)
      }
    }

    const ensureBlockBadges = () => {
      document.querySelectorAll<HTMLElement>("[data-block-id]").forEach((node) => {
        const blockType = node.getAttribute("data-block-type") ?? "Block"

        if (node.querySelector(".editor-block-badge")) {
          node.classList.add("editor-has-badge")
          return
        }

        const badge = document.createElement("div")
        badge.className = "editor-block-badge"

        const label = document.createElement("span")
        label.className = "editor-block-badge-label"
        label.textContent = blockType

        badge.append(label)
        node.prepend(badge)
        node.classList.add("editor-has-badge")
      })

      if (selectedBlockRef.current && selectedEditablePathRef.current) {
        applyChildFocus(selectedBlockRef.current, selectedEditablePathRef.current)
      }
    }

    const applyBlockFocus = (blockId: string, enter: boolean, editablePath?: string, options?: { scrollIntoView?: boolean }) => {
      if (!blockId) return false
      clearChildFocus()
      removeSelectedDeleteHandle()
      document.querySelectorAll(".editor-highlight").forEach((node) => node.classList.remove("editor-highlight"))
      const match = findBlockNode(blockId)
      if (!match) return false

      if (enter) match.classList.add("editor-enter")
      match.classList.add("editor-highlight", "editor-flash")
      if (enter) {
        match.classList.remove("aifx-updated")
        // Force reflow so repeated updates can replay the wave animation.
        void match.offsetWidth
        match.classList.add("aifx-updated")
        window.setTimeout(() => {
          match.classList.remove("aifx-updated")
        }, 980)
      }
      if (options?.scrollIntoView !== false) {
        match.scrollIntoView({ behavior: "smooth", block: "center" })
      }

      window.setTimeout(() => {
        match.classList.remove("editor-flash")
        match.classList.remove("editor-enter")
      }, 280)

      // Create a toolbar container for action buttons
      const toolbar = document.createElement("div")
      toolbar.className = "editor-block-toolbar"

      const moveUpBtn = document.createElement("button")
      moveUpBtn.type = "button"
      moveUpBtn.className = "editor-selected-move editor-selected-move-up"
      moveUpBtn.setAttribute("aria-label", `Move ${match.getAttribute("data-block-type") ?? "block"} up`)
      moveUpBtn.title = "Move up"
      moveUpBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 10V2"/><path d="M2.5 5.5L6 2l3.5 3.5"/></svg>'
      const upResult = computeMoveAfter(blockId, "up")
      moveUpBtn.disabled = !upResult.canMove
      moveUpBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const move = computeMoveAfter(blockId, "up")
        if (!move.canMove) return
        window.parent.postMessage(
          { protocol: "site-editor/v1", type: "blockReordered", payload: { slug, blockId, afterBlockId: move.afterBlockId } },
          editorOrigin
        )
      })

      const moveDownBtn = document.createElement("button")
      moveDownBtn.type = "button"
      moveDownBtn.className = "editor-selected-move editor-selected-move-down"
      moveDownBtn.setAttribute("aria-label", `Move ${match.getAttribute("data-block-type") ?? "block"} down`)
      moveDownBtn.title = "Move down"
      moveDownBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2v8"/><path d="M2.5 6.5L6 10l3.5-3.5"/></svg>'
      const downResult = computeMoveAfter(blockId, "down")
      moveDownBtn.disabled = !downResult.canMove
      moveDownBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const move = computeMoveAfter(blockId, "down")
        if (!move.canMove) return
        window.parent.postMessage(
          { protocol: "site-editor/v1", type: "blockReordered", payload: { slug, blockId, afterBlockId: move.afterBlockId } },
          editorOrigin
        )
      })

      const addBtn = document.createElement("button")
      addBtn.type = "button"
      addBtn.className = "editor-selected-add editor-selected-add-bottom"
      addBtn.setAttribute("aria-label", `Add block after ${match.getAttribute("data-block-type") ?? "block"}`)
      addBtn.title = "Add block below"
      addBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2v8"/><path d="M2 6h8"/></svg>'
      addBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        window.parent.postMessage(
          {
            protocol: "site-editor/v1",
            type: "blockAddRequested",
            payload: { slug, afterBlockId: blockId }
          },
          editorOrigin
        )
      })

      const addTopBtn = document.createElement("button")
      addTopBtn.type = "button"
      addTopBtn.className = "editor-selected-add editor-selected-add-top"
      addTopBtn.setAttribute("aria-label", `Add block before ${match.getAttribute("data-block-type") ?? "block"}`)
      addTopBtn.title = "Add block above"
      addTopBtn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 2v8"/><path d="M2 6h8"/></svg>'
      addTopBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const anchor = computeInsertBefore(blockId)
        window.parent.postMessage(
          {
            protocol: "site-editor/v1",
            type: "blockAddRequested",
            payload: {
              slug,
              ...(anchor.afterBlockId ? { afterBlockId: anchor.afterBlockId } : {}),
              ...(anchor.beforeBlockId ? { beforeBlockId: anchor.beforeBlockId } : {})
            }
          },
          editorOrigin
        )
      })

      const previousSelectedBlockId = selectedBlockRef.current
      const previousEditablePath = selectedEditablePathRef.current
      const effectivePath = editablePath ?? (previousSelectedBlockId === blockId ? previousEditablePath ?? undefined : undefined)
      toolbar.append(moveUpBtn, moveDownBtn)
      match.prepend(toolbar)
      match.prepend(addTopBtn)
      match.append(addBtn)
      mountListItemDeleteHandles(match, blockId)
      mountSelectedDeleteHandle()
      applyListItemSelection(match, effectivePath)
      selectedBlockRef.current = blockId
      if (!effectivePath) selectedEditablePathRef.current = null
      if (effectivePath) applyChildFocus(blockId, effectivePath)
      return true
    }

    const queueFocusAfterRefresh = () => {
      const targetId = pendingFocusRef.current
      if (!targetId) return

      let attempts = 0
      const timer = window.setInterval(() => {
        const done = applyBlockFocus(targetId, true, undefined, { scrollIntoView: pendingScrollIntoViewRef.current })
        attempts += 1
        if (done || attempts >= 20) {
          window.clearInterval(timer)
          pendingFocusRef.current = null
          pendingScrollIntoViewRef.current = false
        }
      }, 45)
    }

    const smoothRefresh = () => {
      if (!pendingScrollIntoViewRef.current) {
        pendingScrollRestoreRef.current = { x: window.scrollX, y: window.scrollY }
      } else {
        pendingScrollRestoreRef.current = null
      }
      cancelInlineEdit()
      router.refresh()
      window.setTimeout(() => {
        if (pendingScrollRestoreRef.current) {
          const { x, y } = pendingScrollRestoreRef.current
          window.scrollTo({ left: x, top: y, behavior: "auto" })
          pendingScrollRestoreRef.current = null
        }
        queueFocusAfterRefresh()
      }, 80)
    }

    const onClick = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntilRef.current) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const target = event.target as HTMLElement | null
      const editing = inlineEditingRef.current
      if (editing && target && !editing.node.contains(target)) {
        commitInlineEdit()
      }
      if (
        target?.closest(".editor-block-delete") ||
        target?.closest(".editor-selected-delete") ||
        target?.closest(".editor-selected-move") ||
        target?.closest(".editor-selected-add") ||
        target?.closest(".editor-list-item-delete") ||
        target?.closest(".editor-list-item-add") ||
        target?.closest(".editor-list-item-move") ||
        target?.closest(".editor-delete-confirm")
      ) {
        return
      }
      const node = target?.closest<HTMLElement>("[data-block-id]")
      if (!node) {
        const hadSelection = !!document.querySelector(".editor-highlight")
        if (hadSelection) {
          clearChildFocus()
          removeSelectedDeleteHandle()
          document.querySelectorAll(".editor-highlight").forEach((n) => n.classList.remove("editor-highlight"))
          selectedBlockRef.current = null
          selectedEditablePathRef.current = null
          window.parent.postMessage(
            { protocol: "site-editor/v1", type: "blockClicked", payload: { slug, blockId: null, blockType: null, editablePath: null } },
            editorOrigin
          )
        }
        return
      }
      const childNode = target?.closest<HTMLElement>("[data-editable-target]")

      // Allow native <details>/<summary> toggle so accordions keep working
      if (!target?.closest("summary")) {
        event.preventDefault()
      }
      event.stopPropagation()

      const blockId = node.getAttribute("data-block-id")
      const blockType = node.getAttribute("data-block-type")
      if (!blockId || !blockType) return

      let editablePath = childNode && node.contains(childNode) ? String(childNode.getAttribute("data-editable-target") ?? "") || undefined : undefined
      if (!editablePath) {
        const itemRoot = target?.closest<HTMLElement>(".editor-item-has-delete")
        if (itemRoot && node.contains(itemRoot)) {
          const firstEditable = itemRoot.querySelector<HTMLElement>("[data-editable-target]")
          editablePath = String(firstEditable?.getAttribute("data-editable-target") ?? "") || undefined
        }
      }
      if (!editablePath) selectedEditablePathRef.current = null
      applyBlockFocus(blockId, false, editablePath)

      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "blockClicked",
          payload: { slug, blockId, blockType, editablePath: editablePath ?? null }
        },
        editorOrigin
      )
    }

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const childNode = target?.closest<HTMLElement>("[data-editable-target]")
      if (!childNode) return
      const node = childNode.closest<HTMLElement>("[data-block-id]")
      if (!node) return

      const blockId = node.getAttribute("data-block-id")
      const blockType = node.getAttribute("data-block-type")
      const editablePath = String(childNode.getAttribute("data-editable-target") ?? "")
      if (!blockId || !blockType || !editablePath) return
      if (!supportsInlineEditablePath(editablePath)) return

      event.preventDefault()
      event.stopPropagation()
      applyBlockFocus(blockId, false, editablePath)
      startInlineEdit({ node: childNode, blockId, blockType, editablePath })
    }

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const item = target?.closest<HTMLElement>(".editor-item-has-delete") ?? null
      if (!item) {
        setHoveredListItem(null)
        return
      }
      const block = item.closest<HTMLElement>(".editor-highlight")
      if (!block) {
        setHoveredListItem(null)
        return
      }
      setHoveredListItem(item)
    }

    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== editorOrigin) return
      const msg = event.data
      if (!msg || msg.protocol !== "site-editor/v1") return

      if (msg.type === "applyPatch") {
        if (serverVersionRef.current !== msg.fromVersion) {
          emitPatchAck(msg.txId, false, "version_mismatch")
          return
        }
        serverVersionRef.current = msg.toVersion
        if (msg.focusBlockId) {
          pendingFocusRef.current = msg.focusBlockId
          pendingScrollIntoViewRef.current = false
        }
        smoothRefresh()
        emitPatchAck(msg.txId, true)
        return
      }

      if (msg.type === "resetToServer") {
        serverVersionRef.current = msg.toVersion
        if (msg.focusBlockId) {
          pendingFocusRef.current = msg.focusBlockId
          pendingScrollIntoViewRef.current = false
        }
        smoothRefresh()
        return
      }

      if (msg.type === "draftUpdated") {
        const focusBlockId = String(msg.payload.focusBlockId ?? "")
        pendingFocusRef.current = focusBlockId || null
        pendingScrollIntoViewRef.current = false
        clearLiveDraft()
        clearChildFocus()
        selectedEditablePathRef.current = null
        smoothRefresh()
      }

      if (msg.type === "highlightBlock") {
        const blockId = String(msg.payload.blockId ?? "")
        const editablePath = String(msg.payload.editablePath ?? "") || undefined
        if (!editablePath) selectedEditablePathRef.current = null
        applyBlockFocus(blockId, false, editablePath)
      }

      if (msg.type === "setNestedLabelsVisibility") {
        setNestedLabelsVisibility(Boolean(msg.payload.visible))
      }

      if (msg.type === "liveDraft") {
        const blockId = String(msg.payload.blockId ?? "")
        const text = String(msg.payload.text ?? "")
        const active = Boolean(msg.payload.active)
        renderLiveDraft(blockId, text, active)
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const editing = inlineEditingRef.current
      if (editing && editing.node.contains(event.target as Node)) {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          cancelInlineEdit()
          return
        }
        if (event.key === "Enter" && (!editing.isMultiline || !event.shiftKey)) {
          event.preventDefault()
          event.stopPropagation()
          commitInlineEdit()
          return
        }
      }

      if (!event.altKey) return
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return

      const target = event.target as HTMLElement | null
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return
      if (target?.isContentEditable) return

      const blockId = selectedBlockRef.current
      if (!blockId) return

      const direction = event.key === "ArrowUp" ? "up" : "down"
      const result = computeMoveAfter(blockId, direction)
      if (!result.canMove) return

      event.preventDefault()
      event.stopPropagation()
      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "blockReordered",
          payload: { slug, blockId, afterBlockId: result.afterBlockId }
        },
        editorOrigin
      )
    }

    ensureBlockBadges()
    const observer = new MutationObserver(() => ensureBlockBadges())
    if (document.body) observer.observe(document.body, { childList: true, subtree: true })

    document.addEventListener("click", onClick, true)
    document.addEventListener("dblclick", onDoubleClick, true)
    document.addEventListener("pointermove", onPointerMove, true)
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("message", onMessage)

    return () => {
      cancelInlineEdit()
      clearChildFocus()
      clearLiveDraft()
      removeSelectedDeleteHandle()
      observer.disconnect()
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("dblclick", onDoubleClick, true)
      document.removeEventListener("pointermove", onPointerMove, true)
      document.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("message", onMessage)
    }
  }, [editorOrigin, router, slug])

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

  return null
}
