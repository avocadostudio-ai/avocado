/**
 * Shared DOM manipulation functions for the editor overlay.
 *
 * These functions are used by both the iframe-based PreviewBridgeCore (postMessage mode)
 * and the immersive editing widget (direct mode). They operate on the site's DOM and
 * communicate back to the editor through injectable callbacks, decoupled from any
 * specific transport (postMessage vs direct).
 */

import { isImagePath } from "@ai-site-editor/shared"

// ---------------------------------------------------------------------------
// Markdown → HTML helper (mirrors _shared.tsx renderRichTextContent)
// ---------------------------------------------------------------------------

function inlineToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>')
}

export function markdownToHtml(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

  const normalized = escaped
    .replace(/\r\n?/g, "\n")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  if (!normalized.includes("\n")) {
    return inlineToHtml(normalized)
  }

  const blocks = normalized.split(/\n\s*\n+/).filter(Boolean)

  return blocks
    .map((block) => {
      const lines = block.split(/\n+/).map((l) => l.trim()).filter(Boolean)
      if (lines.length === 0) return ""

      const hMatch = /^(#{1,6})\s+(.+)$/.exec(lines[0])
      if (hMatch) {
        let html = `<h3>${inlineToHtml(hMatch[2].trim())}</h3>`
        const rest = lines.slice(1).join(" ").trim()
        if (rest) html += `<p>${inlineToHtml(rest)}</p>`
        return html
      }

      const ulItems = lines.map((l) => /^\s*[-*+•]\s+(.+)$/.exec(l)?.[1]?.trim() ?? null)
      if (ulItems.every((i) => i !== null)) {
        return `<ul>${ulItems.map((i) => `<li>${inlineToHtml(i!)}</li>`).join("")}</ul>`
      }

      const olItems = lines.map((l) => /^\s*\d+[.)]\s+(.+)$/.exec(l)?.[1]?.trim() ?? null)
      if (olItems.every((i) => i !== null)) {
        return `<ol>${olItems.map((i) => `<li>${inlineToHtml(i!)}</li>`).join("")}</ol>`
      }

      return `<p>${inlineToHtml(block)}</p>`
    })
    .join("")
}

// ---------------------------------------------------------------------------
// Pure DOM queries
// ---------------------------------------------------------------------------

export function findBlockNode(blockId: string): HTMLElement | null {
  if (!blockId) return null
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return document.querySelector<HTMLElement>(`[data-block-id='${CSS.escape(blockId)}']`)
  }
  return document.querySelector<HTMLElement>(`[data-block-id='${blockId}']`)
}

export function findEditableNode(parent: HTMLElement, editablePath: string): HTMLElement | null {
  const nodes = parent.querySelectorAll<HTMLElement>("[data-editable-target]")
  for (const node of nodes) {
    if ((node.getAttribute("data-editable-target") ?? "") === editablePath) return node
  }
  return null
}

export function parseListItemPath(editablePath?: string | null): { listKey: string; index: number } | null {
  const path = String(editablePath ?? "")
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+)\](?:\.|$)/.exec(path)
  if (!match) return null
  return { listKey: match[1], index: Number(match[2]) }
}

export function supportsInlineEditablePath(editablePath: string): boolean {
  if (!editablePath) return false
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[[0-9]+\]\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(editablePath)) return false
  if (/(^|\.)(?:ctaHref|secondaryCtaHref|imageUrl|imageAlt|href|url)$/i.test(editablePath)) return false
  if (/\]\.(src|alt|poster)$/i.test(editablePath)) return false
  return true
}

export function readNodeText(node: HTMLElement): string {
  return node.innerText.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ")
}

export function placeCaretAtEnd(node: HTMLElement): void {
  const selection = window.getSelection?.()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function orderedBlockNodes(): HTMLElement[] {
  const main = document.querySelector("main.editor-mode, main")
  const directChildren = main
    ? Array.from(main.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-block-id"))
    : []
  if (directChildren.length > 0) return directChildren
  return Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
}

export function blockOrderIndex(blockId: string, preferredNode?: HTMLElement | null): { idx: number; order: string[] } {
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

export function computeMoveAfter(blockId: string, direction: "up" | "down", preferredNode?: HTMLElement | null): { canMove: boolean; afterBlockId: string | null } {
  const { idx, order } = blockOrderIndex(blockId, preferredNode)
  if (idx === -1) return { canMove: false, afterBlockId: null }
  if (direction === "up") {
    if (idx === 0) return { canMove: false, afterBlockId: null }
    return { canMove: true, afterBlockId: idx - 2 >= 0 ? order[idx - 2] : null }
  }
  if (idx >= order.length - 1) return { canMove: false, afterBlockId: null }
  return { canMove: true, afterBlockId: order[idx + 1] ?? null }
}

export function computeInsertBefore(blockId: string, preferredNode?: HTMLElement | null): { afterBlockId: string | null; beforeBlockId: string } {
  const { idx, order } = blockOrderIndex(blockId, preferredNode)
  if (idx <= 0) return { afterBlockId: null, beforeBlockId: blockId }
  return { afterBlockId: order[idx - 1] ?? null, beforeBlockId: blockId }
}

export function groupListItemNodes(block: HTMLElement): Array<{ listKey: string; index: number; nodes: HTMLElement[] }> {
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

export function commonItemRoot(block: HTMLElement, nodes: HTMLElement[]): HTMLElement | null {
  if (nodes.length === 0) return null
  let candidate: HTMLElement | null = nodes[0]
  while (candidate && !nodes.every((node) => candidate?.contains(node))) {
    candidate = candidate.parentElement
  }
  if (!candidate || candidate === block) return null
  if (!block.contains(candidate)) return null
  return candidate
}

// ---------------------------------------------------------------------------
// Stateless DOM mutations
// ---------------------------------------------------------------------------

export function setNestedLabelsVisibility(visible: boolean): void {
  document.documentElement.classList.toggle("editor-hide-nested-labels", !visible)
}

export function clearChildFocus(): void {
  document.querySelectorAll(".editor-child-highlight").forEach((node) => node.classList.remove("editor-child-highlight"))
}

export function showSkeleton(afterBlockId: string | null, blockType: string): void {
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
  const main = document.querySelector("main") ?? document.body
  main.append(skeleton)
}

export function removeSkeletons(): void {
  document.querySelectorAll(".editor-skeleton-block").forEach((node) => node.remove())
}

export function ensureBlockBadges(): void {
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
}

export function clearListItemSelection(scope?: ParentNode): void {
  ;(scope ?? document).querySelectorAll(".editor-item-selected").forEach((node) => node.classList.remove("editor-item-selected"))
  ;(scope ?? document).querySelectorAll(".editor-child-selected").forEach((node) => node.classList.remove("editor-child-selected"))
  ;(scope ?? document).querySelectorAll(".editor-child-selection-locked").forEach((node) => node.classList.remove("editor-child-selection-locked"))
}

export function removeOverlayControls(deleteConfirmTimer: { current: number | null }): void {
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
  if (deleteConfirmTimer.current) {
    window.clearTimeout(deleteConfirmTimer.current)
    deleteConfirmTimer.current = null
  }
}

export function clearAllHighlights(): void {
  document.querySelectorAll(".editor-highlight").forEach((node) => node.classList.remove("editor-highlight"))
}

export function applyAiFieldLoading(blockId: string, editablePath: string, active: boolean): void {
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

export function cleanupOverlayElements(): void {
  document.querySelectorAll(".aifx-shimmer-overlay, .aifx-shimmer-sparkle, .editor-image-change-btn").forEach((el) => el.remove())
  document.documentElement.removeAttribute("data-editor-active")
  document.documentElement.removeAttribute("data-editor-selection-mode")
}

// ---------------------------------------------------------------------------
// Stateful bridge — factory that creates bound functions with shared state
// ---------------------------------------------------------------------------

/** Callbacks for communicating user actions back to the editor/widget. */
export type BridgeCallbacks = {
  onBlockClicked: (payload: {
    slug: string; blockId: string | null; blockType: string | null
    editablePath: string | null; editableValue: string | null; anchorRect: { top: number; left: number; width: number; height: number } | null
  }) => void
  onBlockDeleteRequested: (payload: { slug: string; blockId: string; blockType: string }) => void
  onBlockReordered: (payload: { slug: string; blockId: string; afterBlockId: string | null }) => void
  onBlockAddRequested: (payload: { slug: string; afterBlockId?: string; beforeBlockId?: string }) => void
  onListItemRemoveRequested: (payload: { slug: string; blockId: string; blockType: string; listKey: string; index: number }) => void
  onListItemAddRequested: (payload: { slug: string; blockId: string; blockType: string; listKey: string; afterIndex: number }) => void
  onListItemMoveRequested: (payload: { slug: string; blockId: string; blockType: string; listKey: string; index: number; afterIndex?: number }) => void
  onInlineTextCommitted: (payload: { slug: string; blockId: string; blockType: string; editablePath: string; value: string }) => void
  onOpenImagePicker: (payload: { slug: string; blockId: string; editablePath: string; currentUrl?: string }) => void
  onScroll: () => void
}

/** Mutable state shared across all bridge functions within one lifecycle. */
export type BridgeState = {
  selectedBlockId: string | null
  selectedEditablePath: string | null
  pendingFocusId: string | null
  pendingScrollIntoView: boolean
  pendingScrollAnchorY: number | null
  pendingScrollRestore: { x: number; y: number } | null
  suppressClickUntil: number
  selectionMode: boolean
  skipParentAnimationOnce: boolean
  deleteConfirmTimer: { current: number | null }
  pendingListItemMovePath: string | null
  childSelectionLock: { blockId: string; listKey: string; index: number; position?: number } | null
  inlineEditing: {
    node: HTMLElement
    blockId: string
    blockType: string
    editablePath: string
    initialValue: string
    isMultiline: boolean
  } | null
  serverVersion: number
  liveDraftActiveBlockId: string | null
  liveDraftBadgeTimer: number | null
  liveDraftOriginals: Map<HTMLElement, string>
  knownBlockIds: Set<string>
  expectingNewBlocks: boolean
  hoveredItemRoot: HTMLElement | null
  hoveredBlockRoot: HTMLElement | null
  observer: MutationObserver | null
  activeShimmer: { blockId: string; editablePath: string } | null
}

export function createBridgeState(): BridgeState {
  return {
    selectedBlockId: null,
    selectedEditablePath: null,
    pendingFocusId: null,
    pendingScrollIntoView: false,
    pendingScrollAnchorY: null,
    pendingScrollRestore: null,
    suppressClickUntil: 0,
    selectionMode: false,
    skipParentAnimationOnce: false,
    deleteConfirmTimer: { current: null },
    pendingListItemMovePath: null,
    childSelectionLock: null,
    inlineEditing: null,
    serverVersion: 0,
    liveDraftActiveBlockId: null,
    liveDraftBadgeTimer: null,
    liveDraftOriginals: new Map(),
    knownBlockIds: new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
        .map((node) => node.getAttribute("data-block-id"))
        .filter((id): id is string => Boolean(id))
    ),
    expectingNewBlocks: false,
    hoveredItemRoot: null,
    hoveredBlockRoot: null,
    observer: null,
    activeShimmer: null,
  }
}

export type BridgeFunctions = ReturnType<typeof createBridgeFunctions>

/**
 * Creates all stateful DOM manipulation functions bound to the given state and callbacks.
 * Used by both PreviewBridgeCore (iframe/postMessage) and the immersive widget (direct).
 */
export function createBridgeFunctions(
  state: BridgeState,
  callbacks: BridgeCallbacks,
  config: { slug: string; pathname: string; refresh: () => void; navigate: (href: string) => void }
) {
  const { slug, pathname, refresh, navigate } = config

  // -- Live draft ----------------------------------------------------------

  const clearLiveDraftBadgeTimer = () => {
    if (state.liveDraftBadgeTimer === null) return
    window.clearTimeout(state.liveDraftBadgeTimer)
    state.liveDraftBadgeTimer = null
  }

  const clearLiveDraft = () => {
    clearLiveDraftBadgeTimer()
    document.querySelectorAll(".editor-live-draft").forEach((node) => node.remove())
    document.querySelectorAll(".editor-live-draft-active").forEach((node) => node.classList.remove("editor-live-draft-active"))
    document.querySelectorAll(".editor-block-badge-status").forEach((node) => node.remove())
    document.querySelectorAll(".editor-live-typing").forEach((node) => node.classList.remove("editor-live-typing"))
    document.querySelectorAll(".editor-skeleton-block").forEach((node) => node.remove())
    state.liveDraftActiveBlockId = null
  }

  const setLiveDraftBadge = (block: HTMLElement, active: boolean) => {
    clearLiveDraftBadgeTimer()
    const badge = block.querySelector<HTMLElement>(".editor-block-badge")
    if (!badge) return
    badge.querySelectorAll(".editor-block-badge-status").forEach((node) => node.remove())
    if (!active) return
    state.liveDraftBadgeTimer = window.setTimeout(() => {
      if (!block.classList.contains("editor-live-draft-active")) return
      const status = document.createElement("span")
      status.className = "editor-block-badge-status"
      status.textContent = "Updating"
      badge.append(status)
    }, 600)
  }

  const restoreLiveDraftOriginals = () => {
    for (const [node, html] of state.liveDraftOriginals) {
      node.innerHTML = html
      node.classList.remove("editor-live-typing")
    }
    state.liveDraftOriginals.clear()
  }

  /** Discard stored originals without restoring them (use after content is committed). */
  const discardLiveDraftOriginals = () => {
    for (const [node] of state.liveDraftOriginals) {
      node.classList.remove("editor-live-typing")
    }
    state.liveDraftOriginals.clear()
    state.liveDraftActiveBlockId = null
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

    const switchingBlock = state.liveDraftActiveBlockId !== null && state.liveDraftActiveBlockId !== blockId
    if (switchingBlock) {
      restoreLiveDraftOriginals()
      clearLiveDraft()
    }

    if (fields && typeof fields === "object") {
      const nextPaths = new Set(Object.keys(fields))
      for (const [node, html] of [...state.liveDraftOriginals.entries()]) {
        const path = node.getAttribute("data-editable-target") ?? ""
        if (!nextPaths.has(path)) {
          node.innerHTML = html
          node.classList.remove("editor-live-typing")
          state.liveDraftOriginals.delete(node)
        }
      }
      for (const [path, value] of Object.entries(fields)) {
        if (isImagePath(path)) continue
        const node = findEditableNode(block, path)
        if (!node) continue
        if (!state.liveDraftOriginals.has(node)) {
          state.liveDraftOriginals.set(node, node.innerHTML)
        }
        node.innerHTML = markdownToHtml(value)
        node.classList.add("editor-live-typing")
      }
    }

    if (state.liveDraftActiveBlockId === blockId) return
    block.classList.add("editor-live-draft-active")
    state.liveDraftActiveBlockId = blockId
    setLiveDraftBadge(block, true)
  }

  // -- Hovered list item ---------------------------------------------------

  const setHoveredListItem = (next: HTMLElement | null) => {
    if (state.hoveredItemRoot === next) return
    if (state.hoveredItemRoot) state.hoveredItemRoot.classList.remove("editor-item-hover")
    if (state.hoveredBlockRoot) state.hoveredBlockRoot.classList.remove("editor-child-hovering")
    state.hoveredItemRoot = next
    state.hoveredBlockRoot = null
    if (!next) return
    next.classList.add("editor-item-hover")
    const block = next.closest<HTMLElement>(".editor-highlight")
    if (!block) return
    block.classList.add("editor-child-hovering")
    state.hoveredBlockRoot = block
  }

  // -- Child selection lock ------------------------------------------------

  const setChildSelectionLock = (next: { blockId: string; listKey: string; index: number; position?: number } | null) => {
    state.childSelectionLock = next
    document.querySelectorAll(".editor-child-selection-locked").forEach((node) => node.classList.remove("editor-child-selection-locked"))
    if (!next) return
    const block = findBlockNode(next.blockId)
    if (!block) return
    block.classList.add("editor-child-selection-locked")
  }

  // -- List item selection -------------------------------------------------

  const applyListItemSelection = (block: HTMLElement, editablePath?: string | null) => {
    clearListItemSelection(block)
    const parsed = parseListItemPath(editablePath)
    if (!parsed) return false
    let itemRoot = block.querySelector<HTMLElement>(
      `.editor-item-has-delete[data-editor-list-key="${parsed.listKey}"][data-editor-list-index="${parsed.index}"]`
    )
    if (!itemRoot) {
      const lock = state.childSelectionLock
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
          state.selectedEditablePath = `${parsed.listKey}[${resolvedIndex}]`
          state.pendingListItemMovePath = state.selectedEditablePath
        }
      }
    }
    if (!itemRoot) return false
    itemRoot.classList.add("editor-item-selected")
    block.classList.add("editor-child-selected")
    const lock = state.childSelectionLock
    if (lock && lock.blockId === (block.getAttribute("data-block-id") ?? "") && lock.listKey === parsed.listKey && lock.index === parsed.index) {
      block.classList.add("editor-child-selection-locked")
    }
    return true
  }

  // -- Child focus ---------------------------------------------------------

  const applyChildFocus = (parentBlockId: string, editablePath?: string) => {
    clearChildFocus()
    state.selectedBlockId = parentBlockId
    state.selectedEditablePath = editablePath ?? null
    if (!editablePath) return
    const parent = findBlockNode(parentBlockId)
    if (!parent) return
    const child = findEditableNode(parent, editablePath)
    if (!child) return
    child.classList.add("editor-child-highlight")
  }

  // -- Inline editing ------------------------------------------------------

  const cancelInlineEdit = () => {
    const s = state.inlineEditing
    if (!s) return
    s.node.textContent = s.initialValue
    s.node.setAttribute("contenteditable", "false")
    s.node.classList.remove("editor-inline-editing")
    state.inlineEditing = null
  }

  const commitInlineEdit = () => {
    const s = state.inlineEditing
    if (!s) return
    s.node.setAttribute("contenteditable", "false")
    s.node.classList.remove("editor-inline-editing")
    state.inlineEditing = null
    const nextValue = readNodeText(s.node)
    if (nextValue === s.initialValue) return
    callbacks.onInlineTextCommitted({ slug, blockId: s.blockId, blockType: s.blockType, editablePath: s.editablePath, value: nextValue })
  }

  const startInlineEdit = (args: { node: HTMLElement; blockId: string; blockType: string; editablePath: string }) => {
    if (!supportsInlineEditablePath(args.editablePath)) return
    if (args.node.children.length > 0) return
    const existing = state.inlineEditing
    if (existing?.node === args.node) return
    if (existing) commitInlineEdit()

    const initialValue = readNodeText(args.node)
    state.inlineEditing = {
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

  // -- Overlay controls (toolbar, delete, move, add) -----------------------

  const removeSelectedDeleteHandle = () => {
    setHoveredListItem(null)
    removeOverlayControls(state.deleteConfirmTimer)
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

      const existing = selected.querySelector(".editor-delete-confirm")
      if (existing) {
        existing.remove()
        if (state.deleteConfirmTimer.current) {
          window.clearTimeout(state.deleteConfirmTimer.current)
          state.deleteConfirmTimer.current = null
        }
        return
      }

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
        if (state.deleteConfirmTimer.current) {
          window.clearTimeout(state.deleteConfirmTimer.current)
          state.deleteConfirmTimer.current = null
        }
        callbacks.onBlockDeleteRequested({ slug, blockId, blockType })
      })
      popover.append(label, confirmBtn)
      selected.prepend(popover)
      state.deleteConfirmTimer.current = window.setTimeout(() => {
        popover.remove()
        state.deleteConfirmTimer.current = null
      }, 4000)
    })

    const toolbar = selected.querySelector(".editor-block-toolbar")
    if (toolbar) {
      toolbar.append(del)
    } else {
      selected.prepend(del)
    }
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

        const existing = controls.querySelector(".editor-delete-confirm")
        if (existing) {
          existing.remove()
          if (state.deleteConfirmTimer.current) {
            window.clearTimeout(state.deleteConfirmTimer.current)
            state.deleteConfirmTimer.current = null
          }
          return
        }

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
          if (state.deleteConfirmTimer.current) {
            window.clearTimeout(state.deleteConfirmTimer.current)
            state.deleteConfirmTimer.current = null
          }
          callbacks.onListItemRemoveRequested({ slug, blockId, blockType, listKey: group.listKey, index: group.index })
        })
        popover.append(label, confirmBtn)
        controls.append(popover)
        state.deleteConfirmTimer.current = window.setTimeout(() => {
          popover.remove()
          state.deleteConfirmTimer.current = null
        }, 3500)
      })
      const order = sortedIndicesByList.get(group.listKey) ?? []
      const pos = order.findIndex((idx) => idx === group.index)
      const canMoveUp = pos > 0
      const canMoveDown = pos >= 0 && pos < order.length - 1
      const upAfterIndex = pos - 2 >= 0 ? order[pos - 2] : undefined
      const downAfterIndex = canMoveDown ? normalizedAfterIndex(group.index, order[pos + 1]) : undefined
      const useHorizontalArrows = horizontalByList.get(group.listKey) === true
      const upIcon = useHorizontalArrows
        ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>'
      const downIcon = useHorizontalArrows
        ? '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 5 7 7-7 7"/><path d="M5 12h14"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m19 12-7 7-7-7"/><path d="M12 5v14"/></svg>'

      const moveUp = document.createElement("button")
      moveUp.type = "button"
      moveUp.className = "editor-list-item-move editor-list-item-move-up"
      moveUp.setAttribute("aria-label", `Move ${group.listKey} item ${useHorizontalArrows ? "left" : "up"}`)
      moveUp.title = useHorizontalArrows ? "Move item left" : "Move item up"
      moveUp.innerHTML = upIcon
      moveUp.disabled = !canMoveUp
      moveUp.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!canMoveUp) return
        const targetPosition = Math.max(0, pos - 1)
        const targetIndex = Number(order[targetPosition] ?? group.index)
        const nextPath = `${group.listKey}[${targetIndex}]`
        state.pendingListItemMovePath = nextPath
        setChildSelectionLock({ blockId, listKey: group.listKey, index: targetIndex, position: targetPosition })
        state.skipParentAnimationOnce = true
        state.selectedEditablePath = nextPath
        state.selectedBlockId = blockId
        setHoveredListItem(null)
        callbacks.onListItemMoveRequested({ slug, blockId, blockType, listKey: group.listKey, index: group.index, afterIndex: upAfterIndex })
      })
      const moveDown = document.createElement("button")
      moveDown.type = "button"
      moveDown.className = "editor-list-item-move editor-list-item-move-down"
      moveDown.setAttribute("aria-label", `Move ${group.listKey} item ${useHorizontalArrows ? "right" : "down"}`)
      moveDown.title = useHorizontalArrows ? "Move item right" : "Move item down"
      moveDown.innerHTML = downIcon
      moveDown.disabled = !canMoveDown
      moveDown.addEventListener("click", (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!canMoveDown || typeof downAfterIndex !== "number") return
        const targetPosition = Math.min(order.length - 1, pos + 1)
        const targetIndex = Number(order[targetPosition] ?? group.index)
        const nextPath = `${group.listKey}[${targetIndex}]`
        state.pendingListItemMovePath = nextPath
        setChildSelectionLock({ blockId, listKey: group.listKey, index: targetIndex, position: targetPosition })
        state.skipParentAnimationOnce = true
        state.selectedEditablePath = nextPath
        state.selectedBlockId = blockId
        setHoveredListItem(null)
        callbacks.onListItemMoveRequested({ slug, blockId, blockType, listKey: group.listKey, index: group.index, afterIndex: downAfterIndex })
      })
      controls.append(moveUp, moveDown, del)
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
        callbacks.onListItemAddRequested({ slug, blockId, blockType, listKey: entry.listKey, afterIndex: entry.index })
      })
      const isHorizontal = horizontalByList.get(entry.listKey)
      if (isHorizontal) {
        add.classList.add("editor-list-item-add--inline")
        const controls = entry.root.querySelector(".editor-list-item-controls")
        if (controls) {
          controls.prepend(add)
        } else {
          entry.root.append(add)
        }
      } else {
        entry.root.append(add)
      }
    }
  }

  // -- Image buttons -------------------------------------------------------

  const mountGlobalImageButtons = () => {
    state.observer?.disconnect()
    document.querySelectorAll(".editor-image-change-btn").forEach((el) => el.remove())
    if (!document.documentElement.hasAttribute("data-editor-selection-mode")) {
      if (state.observer && document.body) state.observer.observe(document.body, { childList: true, subtree: true })
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
    if (state.observer && document.body) state.observer.observe(document.body, { childList: true, subtree: true })
  }

  // -- Block focus ---------------------------------------------------------

  const applyBlockFocus = (blockId: string, enter: boolean, editablePath?: string, options?: { scrollIntoView?: boolean }) => {
    if (!blockId) return false
    clearChildFocus()
    removeSelectedDeleteHandle()
    clearAllHighlights()
    const match = findBlockNode(blockId)
    if (!match) return false

    const shouldAnimate = enter
    if (shouldAnimate && !match.classList.contains("editor-block-entering")) match.classList.add("editor-enter")
    match.classList.add("editor-highlight")
    if (shouldAnimate) match.classList.add("editor-flash")
    if (shouldAnimate) {
      match.classList.remove("aifx-updated")
      void match.offsetWidth
      match.classList.add("aifx-updated")
      window.setTimeout(() => { match.classList.remove("aifx-updated") }, 980)
    }
    if (options?.scrollIntoView !== false) {
      const anchorY = state.pendingScrollAnchorY
      if (anchorY !== null) {
        const currentTop = match.getBoundingClientRect().top
        window.scrollBy({ top: currentTop - anchorY, behavior: "instant" })
        state.pendingScrollAnchorY = null
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
      state.pendingScrollAnchorY = match.getBoundingClientRect().top
      state.pendingScrollIntoView = true
      callbacks.onBlockReordered({ slug, blockId, afterBlockId: move.afterBlockId })
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
      state.pendingScrollAnchorY = match.getBoundingClientRect().top
      state.pendingScrollIntoView = true
      callbacks.onBlockReordered({ slug, blockId, afterBlockId: move.afterBlockId })
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
      callbacks.onBlockAddRequested({ slug, afterBlockId: blockId })
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
      callbacks.onBlockAddRequested({
        slug,
        ...(anchor.afterBlockId ? { afterBlockId: anchor.afterBlockId } : {}),
        ...(anchor.beforeBlockId ? { beforeBlockId: anchor.beforeBlockId } : {}),
      })
    })

    const previousSelectedBlockId = state.selectedBlockId
    const previousEditablePath = state.selectedEditablePath
    const effectivePath = editablePath ?? (previousSelectedBlockId === blockId ? previousEditablePath ?? undefined : undefined)

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
    state.selectedBlockId = blockId
    if (!effectivePath) state.selectedEditablePath = null
    if (effectivePath) applyChildFocus(blockId, effectivePath)
    return true
  }

  // -- Focus after refresh -------------------------------------------------

  const queueFocusAfterRefresh = () => {
    const targetId = state.pendingFocusId
    if (!targetId) return

    let attempts = 0
    const timer = window.setInterval(() => {
      const shouldAnimate = !state.skipParentAnimationOnce
      const done = applyBlockFocus(targetId, shouldAnimate, undefined, { scrollIntoView: state.pendingScrollIntoView })
      attempts += 1
      if (done || attempts >= 20) {
        window.clearInterval(timer)
        state.pendingFocusId = null
        state.pendingScrollIntoView = false
        state.pendingScrollAnchorY = null
        state.skipParentAnimationOnce = false
      }
    }, 45)
  }

  // -- Smooth refresh ------------------------------------------------------

  const smoothRefresh = (useViewTransition = false) => {
    if (!state.pendingScrollIntoView) {
      state.pendingScrollRestore = { x: window.scrollX, y: window.scrollY }
    } else {
      state.pendingScrollRestore = null
    }
    cancelInlineEdit()

    const restoreAndFocus = () => {
      if (state.pendingScrollRestore) {
        const { x, y } = state.pendingScrollRestore
        window.scrollTo({ left: x, top: y, behavior: "auto" })
        state.pendingScrollRestore = null
      }
      queueFocusAfterRefresh()
      // Re-apply shimmer if it was active before the refresh destroyed DOM
      if (state.activeShimmer) {
        applyAiFieldLoading(state.activeShimmer.blockId, state.activeShimmer.editablePath, true)
      }
    }

    const doRefreshAndRestore = () => {
      refresh()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          restoreAndFocus()
        })
      })
    }

    if (useViewTransition && typeof document.startViewTransition === "function") {
      document.startViewTransition(() => {
        refresh()
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

  // -- New block detection -------------------------------------------------

  const detectNewBlocks = () => {
    if (!state.expectingNewBlocks) return
    const currentIds = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-block-id]"))
        .map((node) => node.getAttribute("data-block-id"))
        .filter((id): id is string => Boolean(id))
    )
    let staggerIndex = 0
    for (const id of currentIds) {
      if (!state.knownBlockIds.has(id)) {
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
    state.knownBlockIds = currentIds
    state.expectingNewBlocks = false
  }

  // -- Event handlers ------------------------------------------------------

  const onClick = (event: MouseEvent) => {
    if (Date.now() < state.suppressClickUntil) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    const target = event.target as HTMLElement | null

    // Ignore clicks inside editor widget overlays (immersive prompt, FAB, panel)
    if (target?.closest("[data-editor-widget-ignore]")) return

    const editing = state.inlineEditing
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
      callbacks.onOpenImagePicker({
        slug: imgBtn.getAttribute("data-image-slug") || pathname || "/",
        blockId: imgBtn.getAttribute("data-image-block-id") || "",
        editablePath: imgBtn.getAttribute("data-image-path") || "",
        currentUrl: imgBtn.getAttribute("data-image-current-url") || undefined,
      })
      return
    }
    // Tab switching
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

    const selectionModeOn = document.documentElement.hasAttribute("data-editor-selection-mode")
    if (!selectionModeOn) return

    const node = target?.closest<HTMLElement>("[data-block-id]")
    if (!node) {
      const hadSelection = !!document.querySelector(".editor-highlight")
      if (hadSelection) {
        clearChildFocus()
        removeSelectedDeleteHandle()
        clearAllHighlights()
        state.selectedBlockId = null
        state.selectedEditablePath = null
        state.pendingListItemMovePath = null
        setChildSelectionLock(null)
        callbacks.onBlockClicked({ slug, blockId: null, blockType: null, editablePath: null, editableValue: null, anchorRect: null })
      }
      return
    }
    const childNode = target?.closest<HTMLElement>("[data-editable-target]")

    const isChrome = !!node.querySelector("[data-block-chrome]") || node.matches("[data-block-chrome]")
    if (!target?.closest("summary") && !isChrome) {
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
      state.selectedEditablePath = null
      state.pendingListItemMovePath = null
      setChildSelectionLock(null)
    } else {
      const parsed = parseListItemPath(editablePath)
      if (parsed) {
        setChildSelectionLock({ blockId, listKey: parsed.listKey, index: parsed.index })
      } else {
        state.pendingListItemMovePath = null
        setChildSelectionLock(null)
      }
    }
    applyBlockFocus(blockId, false, editablePath)

    let editableValue: string | null = null
    if (editablePath && isImagePath(editablePath) && childNode) {
      const img = childNode.querySelector("img")
      if (img?.src) editableValue = img.src
    }

    callbacks.onBlockClicked({
      slug, blockId, blockType, editablePath: editablePath ?? null, editableValue,
      anchorRect: (() => {
        const r = node.getBoundingClientRect()
        return { top: r.top, left: r.left, width: r.width, height: r.height }
      })(),
    })
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
    if (state.childSelectionLock) {
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

  const onKeyDown = (event: KeyboardEvent) => {
    const editing = state.inlineEditing
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

    const blockId = state.selectedBlockId
    if (!blockId) return

    const direction = event.key === "ArrowUp" ? "up" : "down"
    const selectedNode = document.querySelector<HTMLElement>(".editor-highlight[data-block-id]")
    const result = computeMoveAfter(blockId, direction, selectedNode)
    if (!result.canMove) return

    event.preventDefault()
    event.stopPropagation()
    state.pendingScrollIntoView = true
    callbacks.onBlockReordered({ slug, blockId, afterBlockId: result.afterBlockId })
  }

  return {
    // Live draft
    clearLiveDraft,
    restoreLiveDraftOriginals,
    discardLiveDraftOriginals,
    renderLiveDraft,
    // Selection
    applyBlockFocus,
    applyChildFocus,
    applyListItemSelection,
    setChildSelectionLock,
    setHoveredListItem,
    // Overlay controls
    removeSelectedDeleteHandle,
    mountSelectedDeleteHandle,
    mountListItemDeleteHandles,
    mountGlobalImageButtons,
    // Inline editing
    startInlineEdit,
    commitInlineEdit,
    cancelInlineEdit,
    // Refresh
    smoothRefresh,
    queueFocusAfterRefresh,
    // New block detection
    detectNewBlocks,
    // Event handlers (to attach to document)
    onClick,
    onDoubleClick,
    onPointerMove,
    onKeyDown,
  }
}
