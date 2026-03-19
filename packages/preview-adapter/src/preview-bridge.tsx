"use client"

import { useEffect, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"
import { isImagePath, type ApplyPatchMessage, type PatchAckMessage, type PatchRejectReason, type ResetToServerMessage } from "@ai-site-editor/shared"

/** Lightweight markdown-to-HTML for live draft streaming. Mirrors _shared.tsx renderRichTextContent but outputs HTML strings. */
function markdownToHtml(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  function inlineToHtml(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
  }

  const normalized = escaped
    .replace(/\r\n?/g, "\n")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  // Single-line content (titles, headings, descriptions): inline-only, no <p> wrapper
  if (!normalized.includes("\n")) {
    return inlineToHtml(normalized)
  }

  const blocks = normalized.split(/\n\s*\n+/).filter(Boolean)

  return blocks
    .map((block) => {
      const lines = block.split(/\n+/).map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) return ""

      // Heading
      const hMatch = /^(#{1,6})\s+(.+)$/.exec(lines[0])
      if (hMatch) {
        let html = `<h3>${inlineToHtml(hMatch[2].trim())}</h3>`
        const rest = lines.slice(1).join(" ").trim()
        if (rest) html += `<p>${inlineToHtml(rest)}</p>`
        return html
      }

      // Unordered list
      const ulItems = lines.map((l) => /^\s*[-*+•]\s+(.+)$/.exec(l)?.[1]?.trim() ?? null)
      if (ulItems.every((i) => i !== null)) {
        return `<ul>${ulItems.map((i) => `<li>${inlineToHtml(i!)}</li>`).join("")}</ul>`
      }

      // Ordered list
      const olItems = lines.map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]?.trim() ?? null)
      if (olItems.every((i) => i !== null)) {
        return `<ol>${olItems.map((i) => `<li>${inlineToHtml(i!)}</li>`).join("")}</ol>`
      }

      return `<p>${inlineToHtml(block)}</p>`
    })
    .join("")
}

type SiteMessage =
  | {
      protocol: "site-editor/v1"
      type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "navigate" | "aiFieldLoading" | "setSelectionMode"
      payload: Record<string, unknown>
    }
  | ({ protocol: "site-editor/v1" } & ApplyPatchMessage)
  | ({ protocol: "site-editor/v1" } & ResetToServerMessage)

export function PreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  // When running standalone (no editor origin), render nothing — there's no parent to talk to.
  if (!editorOrigin) return null

  return <PreviewBridgeInner slug={slug} editorOrigin={editorOrigin} />
}

function PreviewBridgeInner({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const pendingFocusRef = useRef<string | null>(null)
  const pendingScrollIntoViewRef = useRef(false)
  const pendingScrollAnchorYRef = useRef<number | null>(null)
  const pendingScrollRestoreRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickUntilRef = useRef(0)
  const selectedBlockRef = useRef<string | null>(null)
  const selectedEditablePathRef = useRef<string | null>(null)
  const pendingListItemMovePathRef = useRef<string | null>(null)
  const childSelectionLockRef = useRef<{ blockId: string; listKey: string; index: number; position?: number } | null>(null)
  const skipParentAnimationOnceRef = useRef(false)
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

    // Signal that the editor overlay is active so CSS styles are gated behind this attribute.
    document.documentElement.setAttribute("data-editor-active", "")

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
      document.querySelectorAll(".editor-live-typing").forEach((node) => node.classList.remove("editor-live-typing"))
      document.querySelectorAll(".editor-skeleton-block").forEach((node) => node.remove())
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
      }, 600)
    }

    const liveDraftOriginals = new Map<HTMLElement, string>()

    const restoreLiveDraftOriginals = () => {
      for (const [node, html] of liveDraftOriginals) {
        node.innerHTML = html
        node.classList.remove("editor-live-typing")
      }
      liveDraftOriginals.clear()
    }

    const renderLiveDraft = (blockId: string, text: string, active: boolean, fields?: Record<string, string>) => {
      if (!active) {
        restoreLiveDraftOriginals()
        clearLiveDraft()
        return
      }
      const trimmed = text.trim()
      if (!blockId || (!trimmed && !fields)) {
        restoreLiveDraftOriginals()
        clearLiveDraft()
        return
      }

      const block = findBlockNode(blockId)
      if (!block) return

      const switchingBlock = liveDraftActiveBlockId !== null && liveDraftActiveBlockId !== blockId
      if (switchingBlock) {
        restoreLiveDraftOriginals()
        clearLiveDraft()
      }

      // Inject streamed text into editable DOM nodes if fields provided
      if (fields && typeof fields === "object") {
        const nextPaths = new Set(Object.keys(fields))
        // Restore stale paths so a new target field takes over immediately.
        for (const [node, html] of [...liveDraftOriginals.entries()]) {
          const path = node.getAttribute("data-editable-target") ?? ""
          if (!nextPaths.has(path)) {
            node.innerHTML = html
            node.classList.remove("editor-live-typing")
            liveDraftOriginals.delete(node)
          }
        }
        for (const [path, value] of Object.entries(fields)) {
          if (isImagePath(path)) continue
          const node = findEditableNode(block, path)
          if (!node) continue
          if (!liveDraftOriginals.has(node)) {
            liveDraftOriginals.set(node, node.innerHTML)
          }
          node.innerHTML = markdownToHtml(value)
          node.classList.add("editor-live-typing")
        }
      }

      if (liveDraftActiveBlockId === blockId) return
      block.classList.add("editor-live-draft-active")
      liveDraftActiveBlockId = blockId
      setLiveDraftBadge(block, true)
    }

    const showSkeleton = (afterBlockId: string | null, blockType: string) => {
      const skeleton = document.createElement("div")
      skeleton.className = "editor-skeleton-block"
      skeleton.setAttribute("data-skeleton-for", blockType)
      if (afterBlockId) {
        const afterNode = findBlockNode(afterBlockId)
        if (afterNode) {
          afterNode.after(skeleton)
          return
        }
      }
      // Fallback: append to body main content
      const main = document.querySelector("main") ?? document.body
      main.append(skeleton)
    }

    const removeSkeletons = () => {
      document.querySelectorAll(".editor-skeleton-block").forEach((node) => node.remove())
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

    const setChildSelectionLock = (next: { blockId: string; listKey: string; index: number; position?: number } | null) => {
      childSelectionLockRef.current = next
      document
        .querySelectorAll(".editor-child-selection-locked")
        .forEach((node) => node.classList.remove("editor-child-selection-locked"))
      if (!next) return
      const block = findBlockNode(next.blockId)
      if (!block) return
      block.classList.add("editor-child-selection-locked")
    }

    const clearListItemSelection = (scope?: ParentNode) => {
      ;(scope ?? document).querySelectorAll(".editor-item-selected").forEach((node) => node.classList.remove("editor-item-selected"))
      ;(scope ?? document)
        .querySelectorAll(".editor-child-selected")
        .forEach((node) => node.classList.remove("editor-child-selected"))
      ;(scope ?? document)
        .querySelectorAll(".editor-child-selection-locked")
        .forEach((node) => node.classList.remove("editor-child-selection-locked"))
    }

    const applyListItemSelection = (block: HTMLElement, editablePath?: string | null) => {
      clearListItemSelection(block)
      const parsed = parseListItemPath(editablePath)
      if (!parsed) return false
      let itemRoot = block.querySelector<HTMLElement>(
        `.editor-item-has-delete[data-editor-list-key="${parsed.listKey}"][data-editor-list-index="${parsed.index}"]`
      )
      if (!itemRoot) {
        const lock = childSelectionLockRef.current
        if (
          lock &&
          lock.blockId === (block.getAttribute("data-block-id") ?? "") &&
          lock.listKey === parsed.listKey &&
          typeof lock.position === "number"
        ) {
          const candidates = Array.from(block.querySelectorAll<HTMLElement>(`.editor-item-has-delete[data-editor-list-key="${parsed.listKey}"]`))
          itemRoot = candidates[lock.position] ?? null
          if (itemRoot) {
            const resolvedIndex = Number(itemRoot.getAttribute("data-editor-list-index") ?? lock.index)
            selectedEditablePathRef.current = `${parsed.listKey}[${resolvedIndex}]`
            pendingListItemMovePathRef.current = selectedEditablePathRef.current
          }
        }
      }
      if (!itemRoot) return false
      itemRoot.classList.add("editor-item-selected")
      block.classList.add("editor-child-selected")
      const lock = childSelectionLockRef.current
      if (lock && lock.blockId === (block.getAttribute("data-block-id") ?? "") && lock.listKey === parsed.listKey && lock.index === parsed.index) {
        block.classList.add("editor-child-selection-locked")
      }
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
      if (/\]\.(src|alt|poster)$/i.test(editablePath)) return false
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
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
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

    const orderedBlockNodes = () => {
      const main = document.querySelector("main.editor-mode, main")
      const directChildren = main
        ? Array.from(main.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-block-id"))
        : []
      if (directChildren.length > 0) return directChildren
      return Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
    }

    const blockOrderIndex = (blockId: string, preferredNode?: HTMLElement | null) => {
      const nodes = orderedBlockNodes()
      const order = nodes
        .map((node) => node.getAttribute("data-block-id"))
        .filter((id): id is string => Boolean(id && id.length > 0))
      if (preferredNode && preferredNode.isConnected) {
        const preferredIndex = nodes.indexOf(preferredNode)
        if (preferredIndex !== -1) return { idx: preferredIndex, order }
      }
      return { idx: order.findIndex((id) => id === blockId), order }
    }

    const computeMoveAfter = (blockId: string, direction: "up" | "down", preferredNode?: HTMLElement | null) => {
      const { idx, order } = blockOrderIndex(blockId, preferredNode)
      if (idx === -1) return { canMove: false, afterBlockId: null as string | null }
      if (direction === "up") {
        if (idx === 0) return { canMove: false, afterBlockId: null as string | null }
        return { canMove: true, afterBlockId: idx - 2 >= 0 ? order[idx - 2] : null }
      }
      if (idx >= order.length - 1) return { canMove: false, afterBlockId: null as string | null }
      return { canMove: true, afterBlockId: order[idx + 1] ?? null }
    }

    const computeInsertBefore = (blockId: string, preferredNode?: HTMLElement | null) => {
      const { idx, order } = blockOrderIndex(blockId, preferredNode)
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
      const firstNodeByListAndIndex = new Map<string, Map<number, HTMLElement>>()
      for (const group of resolved) {
        perListCounts.set(group.listKey, (perListCounts.get(group.listKey) ?? 0) + 1)
        const currentLast = lastByList.get(group.listKey)
        if (!currentLast || group.index > currentLast.index) {
          lastByList.set(group.listKey, { listKey: group.listKey, index: group.index, root: group.root })
        }
        if (!sortedIndicesByList.has(group.listKey)) sortedIndicesByList.set(group.listKey, [])
        sortedIndicesByList.get(group.listKey)?.push(group.index)
        if (!firstNodeByListAndIndex.has(group.listKey)) firstNodeByListAndIndex.set(group.listKey, new Map())
        firstNodeByListAndIndex.get(group.listKey)?.set(group.index, group.nodes[0])
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
        // Use first editable nodes (not roots) — roots may be the same shared
        // ancestor (e.g. Tabs where label + content share section__inner).
        const nodes = firstNodeByListAndIndex.get(listKey)
        const first = nodes?.get(order[0]!)
        const second = nodes?.get(order[1]!)
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
        if (horizontalByList.get(group.listKey)) root.classList.add("editor-list-horizontal")
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
          '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
        del.disabled = (perListCounts.get(group.listKey) ?? 0) <= 1
        del.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (del.disabled) return

          // If confirm popover already showing, dismiss it
          const existing = controls.querySelector(".editor-delete-confirm")
          if (existing) {
            existing.remove()
            if (deleteConfirmTimerRef.current) {
              window.clearTimeout(deleteConfirmTimerRef.current)
              deleteConfirmTimerRef.current = null
            }
            return
          }

          // Remove any other open confirm popovers
          document.querySelectorAll(".editor-list-item-controls .editor-delete-confirm").forEach((el) => el.remove())

          const popover = document.createElement("div")
          popover.className = "editor-delete-confirm editor-delete-confirm--list"
          const label = document.createElement("span")
          label.textContent = "Delete item?"
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
              {
                protocol: "site-editor/v1",
                type: "listItemRemoveRequested",
                payload: { slug, blockId, blockType, listKey: group.listKey, index: group.index }
              },
              editorOrigin
            )
          })
          popover.append(label, confirmBtn)
          controls.append(popover)
          deleteConfirmTimerRef.current = window.setTimeout(() => {
            popover.remove()
            deleteConfirmTimerRef.current = null
          }, 3500)
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
          ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>'
        const downIcon = showHorizontalDown
          ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 5 7 7-7 7"/><path d="M5 12h14"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m19 12-7 7-7-7"/><path d="M12 5v14"/></svg>'

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
          const targetPosition = Math.max(0, pos - 1)
          const targetIndex = Number(order[targetPosition] ?? group.index)
          const nextPath = `${group.listKey}[${targetIndex}]`
          pendingListItemMovePathRef.current = nextPath
          setChildSelectionLock({ blockId, listKey: group.listKey, index: targetIndex, position: targetPosition })
          skipParentAnimationOnceRef.current = true
          selectedEditablePathRef.current = nextPath
          selectedBlockRef.current = blockId
          setHoveredListItem(null)
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
          const targetPosition = Math.min(order.length - 1, pos + 1)
          const targetIndex = Number(order[targetPosition] ?? group.index)
          const nextPath = `${group.listKey}[${targetIndex}]`
          pendingListItemMovePathRef.current = nextPath
          setChildSelectionLock({ blockId, listKey: group.listKey, index: targetIndex, position: targetPosition })
          skipParentAnimationOnceRef.current = true
          selectedEditablePathRef.current = nextPath
          selectedBlockRef.current = blockId
          setHoveredListItem(null)
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
        add.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'
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
        const isHorizontal = horizontalByList.get(entry.listKey)
        if (isHorizontal) {
          add.classList.add("editor-list-item-add--inline")
          const controls = entry.root.querySelector(".editor-list-item-controls")
          if (controls) {
            controls.append(add)
          } else {
            entry.root.append(add)
          }
        } else {
          entry.root.append(add)
        }
      }
    }

    let observer: MutationObserver | null = null

    const mountGlobalImageButtons = () => {
      // Prevent MutationObserver feedback loops while rebuilding image buttons.
      observer?.disconnect()
      document.querySelectorAll(".editor-image-change-btn").forEach((el) => el.remove())
      // Only show image picker buttons when selection mode is active
      if (!document.documentElement.hasAttribute("data-editor-selection-mode")) {
        if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true })
        return
      }
      document.querySelectorAll<HTMLElement>(".editor-selectable [data-editable-target]").forEach((el) => {
        const path = el.getAttribute("data-editable-target") ?? ""
        if (!isImagePath(path)) return
        const block = el.closest<HTMLElement>("[data-block-id]")
        if (!block) return
        const blockId = block.getAttribute("data-block-id") ?? ""
        const currentSlug = pathname || "/"

        const img = el.querySelector<HTMLImageElement>("img")
        const currentUrl = img?.getAttribute("src") ?? undefined

        // Ensure parent is positioned for absolute button placement
        const style = window.getComputedStyle(el)
        if (style.position === "static") {
          el.style.position = "relative"
        }

        const btn = document.createElement("button")
        btn.className = "editor-image-change-btn"
        btn.title = "Change image"
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>'
        btn.setAttribute("data-image-slug", currentSlug)
        btn.setAttribute("data-image-block-id", blockId)
        btn.setAttribute("data-image-path", path)
        if (currentUrl) btn.setAttribute("data-image-current-url", currentUrl)
        el.append(btn)
      })
      if (observer && document.body) observer.observe(document.body, { childList: true, subtree: true })
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

      const shouldAnimate = enter
      if (shouldAnimate && !match.classList.contains("editor-block-entering")) match.classList.add("editor-enter")
      match.classList.add("editor-highlight")
      if (shouldAnimate) match.classList.add("editor-flash")
      if (shouldAnimate) {
        match.classList.remove("aifx-updated")
        // Force reflow so repeated updates can replay the wave animation.
        void match.offsetWidth
        match.classList.add("aifx-updated")
        window.setTimeout(() => {
          match.classList.remove("aifx-updated")
        }, 980)
      }
      if (options?.scrollIntoView !== false) {
        const anchorY = pendingScrollAnchorYRef.current
        if (anchorY !== null) {
          const currentTop = match.getBoundingClientRect().top
          window.scrollBy({ top: currentTop - anchorY, behavior: "instant" })
          pendingScrollAnchorYRef.current = null
        } else {
          match.scrollIntoView({ behavior: "smooth", block: "center" })
        }
      }

      if (shouldAnimate) {
        window.setTimeout(() => {
          match.classList.remove("editor-flash")
          match.classList.remove("editor-enter")
        }, 280)
      }

      // Create a toolbar container for action buttons
      const toolbar = document.createElement("div")
      toolbar.className = "editor-block-toolbar"

      const moveUpBtn = document.createElement("button")
      moveUpBtn.type = "button"
      moveUpBtn.className = "editor-selected-move editor-selected-move-up"
      moveUpBtn.setAttribute("aria-label", `Move ${match.getAttribute("data-block-type") ?? "block"} up`)
      moveUpBtn.title = "Move up"
      moveUpBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>'
      const upResult = computeMoveAfter(blockId, "up", match)
      moveUpBtn.disabled = !upResult.canMove
      if (!upResult.canMove) moveUpBtn.title = "Already at the top"
      moveUpBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const move = computeMoveAfter(blockId, "up", match)
        if (!move.canMove) return
        pendingScrollAnchorYRef.current = match.getBoundingClientRect().top
        pendingScrollIntoViewRef.current = true
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
      moveDownBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m19 12-7 7-7-7"/><path d="M12 5v14"/></svg>'
      const downResult = computeMoveAfter(blockId, "down", match)
      moveDownBtn.disabled = !downResult.canMove
      if (!downResult.canMove) moveDownBtn.title = "Already at the bottom"
      moveDownBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const move = computeMoveAfter(blockId, "down", match)
        if (!move.canMove) return
        pendingScrollAnchorYRef.current = match.getBoundingClientRect().top
        pendingScrollIntoViewRef.current = true
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
      addBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'
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
      addTopBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14"/><path d="M5 12h14"/></svg>'
      addTopBtn.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        const anchor = computeInsertBefore(blockId, match)
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
      // const editBtn = document.createElement("button")
      // editBtn.type = "button"
      // editBtn.className = "editor-selected-edit"
      // editBtn.setAttribute("aria-label", "Edit with AI")
      // editBtn.title = "Edit with AI"
      // editBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>'
      // editBtn.addEventListener("click", (event) => {
      //   event.preventDefault()
      //   event.stopPropagation()
      //   window.parent.postMessage(
      //     { protocol: "site-editor/v1", type: "editBlockRequested", payload: { slug, blockId } },
      //     editorOrigin
      //   )
      // })

      const isChromeBlock = match.querySelector("[data-block-chrome]") !== null || match.matches("[data-block-chrome]")
      if (!isChromeBlock) {
        toolbar.append(moveUpBtn, moveDownBtn)
        match.prepend(toolbar)
        match.prepend(addTopBtn)
        match.append(addBtn)
        mountListItemDeleteHandles(match, blockId)
        mountSelectedDeleteHandle()
      }
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
        const shouldAnimate = !skipParentAnimationOnceRef.current
        const done = applyBlockFocus(targetId, shouldAnimate, undefined, { scrollIntoView: pendingScrollIntoViewRef.current })
        attempts += 1
        if (done || attempts >= 20) {
          window.clearInterval(timer)
          pendingFocusRef.current = null
          pendingScrollIntoViewRef.current = false
          pendingScrollAnchorYRef.current = null
          skipParentAnimationOnceRef.current = false
        }
      }, 45)
    }

    const smoothRefresh = (useViewTransition = false) => {
      if (!pendingScrollIntoViewRef.current) {
        pendingScrollRestoreRef.current = { x: window.scrollX, y: window.scrollY }
      } else {
        pendingScrollRestoreRef.current = null
      }
      cancelInlineEdit()

      const restoreAndFocus = () => {
        if (pendingScrollRestoreRef.current) {
          const { x, y } = pendingScrollRestoreRef.current
          window.scrollTo({ left: x, top: y, behavior: "auto" })
          pendingScrollRestoreRef.current = null
        }
        queueFocusAfterRefresh()
      }

      const doRefreshAndRestore = () => {
        router.refresh()
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            restoreAndFocus()
          })
        })
      }

      // View Transition: only used for AI-driven updates (streaming ops) where a
      // crossfade helps mask the RSC round-trip. Direct user actions (move, delete,
      // inline edit) skip this to stay responsive.
      if (useViewTransition && typeof document.startViewTransition === "function") {
        document.startViewTransition(() => {
          router.refresh()
          return new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                restoreAndFocus()
                resolve()
              })
            })
          })
        })
      } else {
        doRefreshAndRestore()
      }
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
        target?.closest(".editor-selected-edit") ||
        target?.closest(".editor-selected-move") ||
        target?.closest(".editor-selected-add") ||
        target?.closest(".editor-list-item-delete") ||
        target?.closest(".editor-list-item-add") ||
        target?.closest(".editor-list-item-move") ||
        target?.closest(".editor-delete-confirm")
      ) {
        return
      }
      const imgBtn = target?.closest<HTMLElement>(".editor-image-change-btn")
      if (imgBtn) {
        event.preventDefault()
        event.stopPropagation()
        window.parent.postMessage(
          {
            protocol: "site-editor/v1",
            type: "openImagePicker",
            payload: {
              slug: imgBtn.getAttribute("data-image-slug") || pathname || "/",
              blockId: imgBtn.getAttribute("data-image-block-id") || "",
              editablePath: imgBtn.getAttribute("data-image-path") || "",
              currentUrl: imgBtn.getAttribute("data-image-current-url") || undefined
            }
          },
          editorOrigin
        )
        return
      }
      // Tab switching must work regardless of selection mode — React re-renders
      // destroy the .onclick handlers set by initTabs, so we handle it here.
      const tabBtn = target?.closest<HTMLElement>(".tabs-block__tab")
      if (tabBtn) {
        const tabsBlock = tabBtn.closest<HTMLElement>(".tabs-block")
        if (tabsBlock) {
          const allTabs = tabsBlock.querySelectorAll<HTMLElement>(".tabs-block__tab")
          const allPanels = tabsBlock.querySelectorAll<HTMLElement>(".tabs-block__panel")
          const idx = Array.from(allTabs).indexOf(tabBtn)
          if (idx >= 0) {
            allTabs.forEach((b, j) => {
              b.classList.toggle("tabs-block__tab--active", idx === j)
              b.setAttribute("aria-selected", idx === j ? "true" : "false")
            })
            allPanels.forEach((p, j) => {
              p.style.display = idx === j ? "" : "none"
            })
          }
        }
      }

      // When selection mode is off, let clicks pass through to the page natively
      const selectionModeOn = document.documentElement.hasAttribute("data-editor-selection-mode")
      if (!selectionModeOn) return

      const node = target?.closest<HTMLElement>("[data-block-id]")
      if (!node) {
        const hadSelection = !!document.querySelector(".editor-highlight")
        if (hadSelection) {
          clearChildFocus()
          removeSelectedDeleteHandle()
          document.querySelectorAll(".editor-highlight").forEach((n) => n.classList.remove("editor-highlight"))
          selectedBlockRef.current = null
          selectedEditablePathRef.current = null
          pendingListItemMovePathRef.current = null
          setChildSelectionLock(null)
          window.parent.postMessage(
            { protocol: "site-editor/v1", type: "blockClicked", payload: { slug, blockId: null, blockType: null, editablePath: null, anchorRect: null } },
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
      if (!editablePath) {
        selectedEditablePathRef.current = null
        pendingListItemMovePathRef.current = null
        setChildSelectionLock(null)
      } else {
        const parsed = parseListItemPath(editablePath)
        if (parsed) {
          setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index })
        } else {
          pendingListItemMovePathRef.current = null
          setChildSelectionLock(null)
        }
      }
      applyBlockFocus(blockId, false, editablePath)

      // For image targets, extract the current src so the editor can show it
      let editableValue: string | null = null
      if (editablePath && isImagePath(editablePath) && childNode) {
        const img = childNode.querySelector("img")
        if (img?.src) editableValue = img.src
      }

      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "blockClicked",
          payload: {
            slug, blockId, blockType, editablePath: editablePath ?? null, editableValue,
            anchorRect: (() => {
              // Keep anchored controls pinned to the selected block corner,
              // even when the user clicked a nested editable field.
              const r = node.getBoundingClientRect()
              return { top: r.top, left: r.left, width: r.width, height: r.height }
            })()
          }
        },
        editorOrigin
      )

    }

    const onDoubleClick = (event: MouseEvent) => {
      if (!document.documentElement.hasAttribute("data-editor-selection-mode")) return
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
      if (!document.documentElement.hasAttribute("data-editor-selection-mode")) {
        setHoveredListItem(null)
        return
      }
      if (childSelectionLockRef.current) {
        setHoveredListItem(null)
        return
      }
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

      if (msg.type === "navigate") {
        const rawHref = String(msg.payload.href ?? "").trim()
        if (!rawHref) return
        const href = rawHref.startsWith("/") ? rawHref : `/${rawHref}`
        const currentHref = `${window.location.pathname}${window.location.search}`
        if (href === currentHref) return
        router.push(href)
        return
      }

      if (msg.type === "setSelectionMode") {
        const enabled = !!msg.payload.enabled
        if (enabled) {
          document.documentElement.setAttribute("data-editor-selection-mode", "")
          mountGlobalImageButtons()
        } else {
          document.documentElement.removeAttribute("data-editor-selection-mode")
          // Remove image picker buttons when selection mode is off
          document.querySelectorAll(".editor-image-change-btn").forEach((el) => el.remove())
        }
        return
      }

      if (msg.type === "applyPatch") {
        if (serverVersionRef.current !== msg.fromVersion) {
          emitPatchAck(msg.txId, false, "version_mismatch")
          return
        }
        serverVersionRef.current = msg.toVersion
        if (msg.focusBlockId) {
          pendingFocusRef.current = msg.focusBlockId
          // Preserve move-triggered follow scroll; default to no scroll for other patch ops.
          pendingScrollIntoViewRef.current = pendingScrollIntoViewRef.current && msg.op?.op === "move_block"
        }
        if (msg.op?.op === "move_item") {
          skipParentAnimationOnceRef.current = true
        }
        expectingNewBlocks = msg.op?.op === "add_block"
        smoothRefresh()
        emitPatchAck(msg.txId, true)
        return
      }

      if (msg.type === "resetToServer") {
        serverVersionRef.current = msg.toVersion
        expectingNewBlocks = true
        if (msg.focusBlockId) {
          pendingFocusRef.current = msg.focusBlockId
          pendingScrollIntoViewRef.current = false
        }
        pendingListItemMovePathRef.current = null
        setChildSelectionLock(null)
        smoothRefresh(true)
        return
      }

      if (msg.type === "draftUpdated") {
        const focusBlockId = String(msg.payload.focusBlockId ?? "")
        pendingFocusRef.current = focusBlockId || null
        // Don't reset pendingScrollIntoViewRef here — move handlers set it to true
        // and we need to preserve that so applyBlockFocus uses anchor-based scrolling.
        expectingNewBlocks = true
        clearLiveDraft()
        clearChildFocus()
        selectedEditablePathRef.current = null
        pendingListItemMovePathRef.current = null
        setChildSelectionLock(null)
        smoothRefresh()
      }

      if (msg.type === "highlightBlock") {
        const blockId = String(msg.payload.blockId ?? "")
        let editablePath = String(msg.payload.editablePath ?? "") || undefined
        if (!editablePath && pendingListItemMovePathRef.current && selectedBlockRef.current === blockId) {
          editablePath = pendingListItemMovePathRef.current
        }
        if (!editablePath) {
          selectedEditablePathRef.current = null
          pendingListItemMovePathRef.current = null
          setChildSelectionLock(null)
        } else if (pendingListItemMovePathRef.current === editablePath) {
          pendingListItemMovePathRef.current = null
          const parsed = parseListItemPath(editablePath)
          if (parsed) {
            const existing = childSelectionLockRef.current
            const position =
              existing && existing.blockId === blockId && existing.listKey === parsed.listKey
                ? existing.position
                : undefined
            setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index, position })
          }
        } else {
          const parsed = parseListItemPath(editablePath)
          if (parsed) {
            const existing = childSelectionLockRef.current
            const position =
              existing && existing.blockId === blockId && existing.listKey === parsed.listKey
                ? existing.position
                : undefined
            setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index, position })
          } else {
            setChildSelectionLock(null)
          }
        }
        applyBlockFocus(blockId, false, editablePath)
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
        renderLiveDraft(blockId, text, active, fields)
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
        // Remove all existing shimmer overlays and restore inline styles
        document.querySelectorAll(".aifx-shimmer-sparkle").forEach((el) => el.remove())
        document.querySelectorAll(".aifx-shimmer-overlay").forEach((el) => {
          const parent = el.parentElement as HTMLElement | null
          el.remove()
          if (parent) {
            const prevOverflow = parent.getAttribute("data-aifx-prev-overflow")
            if (prevOverflow !== null) {
              if (prevOverflow.length > 0) parent.style.overflow = prevOverflow
              else parent.style.removeProperty("overflow")
              parent.removeAttribute("data-aifx-prev-overflow")
            }
            const prevPosition = parent.getAttribute("data-aifx-prev-position")
            if (prevPosition !== null) {
              if (prevPosition.length > 0) parent.style.position = prevPosition
              else parent.style.removeProperty("position")
              parent.removeAttribute("data-aifx-prev-position")
            }
            if (!parent.style.cssText.trim()) parent.removeAttribute("style")
          }
        })
        if (active && blockId) {
          const block = findBlockNode(blockId)
          if (block) {
            const target = editablePath ? findEditableNode(block, editablePath) : block
            if (target) {
              const overlay = document.createElement("div")
              overlay.className = "aifx-shimmer-overlay"
              const sparkle = document.createElement("div")
              sparkle.className = "aifx-shimmer-sparkle"
              sparkle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>'
              if (!target.hasAttribute("data-aifx-prev-position")) {
                target.setAttribute("data-aifx-prev-position", target.style.position)
              }
              target.style.position = target.style.position || "relative"
              target.appendChild(overlay)
              // Append sparkle to toolbar (inherits show/hide), fallback to target
              const highlight = block.closest(".editor-highlight") ?? block
              const toolbar = highlight.querySelector(".editor-block-toolbar")
              if (toolbar) {
                toolbar.appendChild(sparkle)
              } else {
                target.appendChild(sparkle)
              }
            }
          }
        }
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
      const selectedNode = document.querySelector<HTMLElement>(".editor-highlight[data-block-id]")
      const result = computeMoveAfter(blockId, direction, selectedNode)
      if (!result.canMove) return

      event.preventDefault()
      event.stopPropagation()
      pendingScrollIntoViewRef.current = true
      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "blockReordered",
          payload: { slug, blockId, afterBlockId: result.afterBlockId }
        },
        editorOrigin
      )
    }

    // Phase 3: Track known block IDs for progressive entrance animation
    let knownBlockIds = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
        .map((node) => node.getAttribute("data-block-id"))
        .filter((id): id is string => Boolean(id))
    )
    let expectingNewBlocks = false

    const detectNewBlocks = () => {
      if (!expectingNewBlocks) return
      const currentIds = new Set(
        Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
          .map((node) => node.getAttribute("data-block-id"))
          .filter((id): id is string => Boolean(id))
      )
      let staggerIndex = 0
      for (const id of currentIds) {
        if (!knownBlockIds.has(id)) {
          const node = findBlockNode(id)
          if (node && !node.classList.contains("editor-block-entering")) {
            const delay = staggerIndex * 120
            node.style.animationDelay = `${delay}ms`
            node.classList.add("editor-block-entering")
            node.addEventListener("animationend", () => {
              node.classList.remove("editor-block-entering")
              node.style.animationDelay = ""
            }, { once: true })
            staggerIndex++
          }
        }
      }
      knownBlockIds = currentIds
      // Run detection only once per refresh cycle to avoid persistent full-DOM scans.
      expectingNewBlocks = false
    }

    let detectNewBlocksRaf: number | null = null
    const scheduleDetectNewBlocks = () => {
      if (detectNewBlocksRaf !== null) return
      detectNewBlocksRaf = requestAnimationFrame(() => {
        detectNewBlocksRaf = null
        detectNewBlocks()
      })
    }

    let imageButtonsRaf: number | null = null
    const scheduleImageButtons = () => {
      if (imageButtonsRaf !== null) return
      imageButtonsRaf = requestAnimationFrame(() => {
        imageButtonsRaf = null
        mountGlobalImageButtons()
      })
    }

    ensureBlockBadges()
    mountGlobalImageButtons()
    observer = new MutationObserver(() => {
      ensureBlockBadges()
      scheduleImageButtons()
      scheduleDetectNewBlocks()
    })
    if (document.body) observer.observe(document.body, { childList: true, subtree: true })

    const onScroll = () => {
      window.parent.postMessage(
        { protocol: "site-editor/v1", type: "iframeScrolled", payload: {} },
        editorOrigin
      )
    }

    document.addEventListener("click", onClick, true)
    document.addEventListener("dblclick", onDoubleClick, true)
    document.addEventListener("pointermove", onPointerMove, true)
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("message", onMessage)
    window.addEventListener("scroll", onScroll, { passive: true })

    return () => {
      if (detectNewBlocksRaf !== null) cancelAnimationFrame(detectNewBlocksRaf)
      if (imageButtonsRaf !== null) cancelAnimationFrame(imageButtonsRaf)
      cancelInlineEdit()
      clearChildFocus()
      restoreLiveDraftOriginals()
      clearLiveDraft()
      removeSelectedDeleteHandle()
      observer?.disconnect()
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("dblclick", onDoubleClick, true)
      document.removeEventListener("pointermove", onPointerMove, true)
      document.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("message", onMessage)
      window.removeEventListener("scroll", onScroll)
      document.querySelectorAll(".aifx-shimmer-overlay, .aifx-shimmer-sparkle, .editor-image-change-btn").forEach((el) => el.remove())
      document.documentElement.removeAttribute("data-editor-active")
      document.documentElement.removeAttribute("data-editor-selection-mode")
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
