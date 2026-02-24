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

  useEffect(() => {
    const applyBlockFocus = (blockId: string, enter: boolean) => {
      if (!blockId) return false
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
      const target = event.target as HTMLElement | null
      const node = target?.closest<HTMLElement>("[data-block-id]")
      if (!node) return

      event.preventDefault()
      event.stopPropagation()

      const blockId = node.getAttribute("data-block-id")
      const blockType = node.getAttribute("data-block-type")
      if (!blockId || !blockType) return

      applyBlockFocus(blockId, false)

      window.parent.postMessage(
        {
          protocol: "site-editor/v1",
          type: "blockClicked",
          payload: { slug, blockId, blockType }
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
        smoothRefresh()
      }

      if (msg.type === "highlightBlock") {
        const blockId = String(msg.payload.blockId ?? "")
        applyBlockFocus(blockId, false)
      }
    }

    document.addEventListener("click", onClick, true)
    window.addEventListener("message", onMessage)

    return () => {
      document.removeEventListener("click", onClick, true)
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
