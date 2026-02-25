"use client"

import { useEffect, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"

type SiteMessage = {
  protocol: "site-editor/v1"
  type: "highlightBlock" | "draftUpdated"
  payload: Record<string, unknown>
}

export function PreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const pendingFocusRef = useRef<string | null>(null)
  const suppressClickUntilRef = useRef(0)
  const selectedBlockRef = useRef<string | null>(null)
  const selectedEditablePathRef = useRef<string | null>(null)
  const deleteConfirmTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const clearChildFocus = () => {
      document.querySelectorAll(".editor-child-highlight").forEach((node) => node.classList.remove("editor-child-highlight"))
    }

    const applyChildFocus = (parentBlockId: string, editablePath?: string) => {
      clearChildFocus()
      if (!editablePath) return
      const parent = document.querySelector<HTMLElement>(`[data-block-id='${parentBlockId}']`)
      if (!parent) return
      const child = parent.querySelector<HTMLElement>(`[data-editable-target='${editablePath}']`)
      if (!child) return
      selectedBlockRef.current = parentBlockId
      selectedEditablePathRef.current = editablePath
      child.classList.add("editor-child-highlight")
    }

    const removeSelectedDeleteHandle = () => {
      document.querySelectorAll(".editor-selected-delete").forEach((node) => node.remove())
      document.querySelectorAll(".editor-selected-move").forEach((node) => node.remove())
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
      del.textContent = ""
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

      selected.prepend(del)
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

    const applyBlockFocus = (blockId: string, enter: boolean, editablePath?: string) => {
      if (!blockId) return false
      clearChildFocus()
      removeSelectedDeleteHandle()
      document.querySelectorAll(".editor-highlight").forEach((node) => node.classList.remove("editor-highlight"))
      const match = document.querySelector<HTMLElement>(`[data-block-id='${blockId}']`)
      if (!match) return false

      if (enter) match.classList.add("editor-enter")
      match.classList.add("editor-highlight", "editor-flash")
      match.scrollIntoView({ behavior: "smooth", block: "center" })

      window.setTimeout(() => {
        match.classList.remove("editor-flash")
        match.classList.remove("editor-enter")
      }, 280)

      const mountSelectedMoveHandle = (direction: "up" | "down") => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `editor-selected-move editor-selected-move-${direction}`
        btn.setAttribute("aria-label", `Move ${match.getAttribute("data-block-type") ?? "block"} ${direction}`)
        btn.title = `Move ${direction}`
        btn.textContent = direction === "up" ? "↑" : "↓"
        const result = computeMoveAfter(blockId, direction)
        btn.disabled = !result.canMove
        btn.addEventListener("click", (event) => {
          event.preventDefault()
          event.stopPropagation()
          const move = computeMoveAfter(blockId, direction)
          if (!move.canMove) return
          window.parent.postMessage(
            {
              protocol: "site-editor/v1",
              type: "blockReordered",
              payload: { slug, blockId, afterBlockId: move.afterBlockId }
            },
            editorOrigin
          )
        })
        match.prepend(btn)
      }

      mountSelectedMoveHandle("up")
      mountSelectedMoveHandle("down")
      mountSelectedDeleteHandle()
      selectedBlockRef.current = blockId
      const effectivePath = editablePath ?? (selectedBlockRef.current === blockId ? selectedEditablePathRef.current ?? undefined : undefined)
      if (effectivePath) applyChildFocus(blockId, effectivePath)
      return true
    }

    const queueFocusAfterRefresh = () => {
      const targetId = pendingFocusRef.current
      if (!targetId) return

      let attempts = 0
      const timer = window.setInterval(() => {
        const done = applyBlockFocus(targetId, true)
        attempts += 1
        if (done || attempts >= 20) {
          window.clearInterval(timer)
          pendingFocusRef.current = null
        }
      }, 45)
    }

    const smoothRefresh = () => {
      router.refresh()
      window.setTimeout(queueFocusAfterRefresh, 80)
    }

    const onClick = (event: MouseEvent) => {
      if (Date.now() < suppressClickUntilRef.current) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const target = event.target as HTMLElement | null
      if (
        target?.closest(".editor-block-delete") ||
        target?.closest(".editor-selected-delete") ||
        target?.closest(".editor-selected-move") ||
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

      event.preventDefault()
      event.stopPropagation()

      const blockId = node.getAttribute("data-block-id")
      const blockType = node.getAttribute("data-block-type")
      if (!blockId || !blockType) return

      const editablePath =
        childNode && node.contains(childNode) ? String(childNode.getAttribute("data-editable-target") ?? "") || undefined : undefined
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

    const onMessage = (event: MessageEvent<SiteMessage>) => {
      if (event.origin !== editorOrigin) return
      const msg = event.data
      if (!msg || msg.protocol !== "site-editor/v1") return

      if (msg.type === "draftUpdated") {
        const focusBlockId = String(msg.payload.focusBlockId ?? "")
        pendingFocusRef.current = focusBlockId || null
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
    }

    const onKeyDown = (event: KeyboardEvent) => {
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
    document.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("message", onMessage)

    return () => {
      clearChildFocus()
      removeSelectedDeleteHandle()
      observer.disconnect()
      document.removeEventListener("click", onClick, true)
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
