import { useState, useEffect, useCallback, useRef } from "react"
import type { HistoryResponse } from "../../lib/editor-types"
import { orchestrator } from "../../lib/editor-utils"
import { useEditorStore } from "../../store"
import { getSessionId, getSiteId } from "../../store/session"
import type { PreviewBridgeFns } from "./types"

export type UndoHistoryDeps = PreviewBridgeFns & {
  refreshRouteSlugs: () => Promise<string[]>
}

export function useUndoHistory(deps: UndoHistoryDeps) {
  const store = useEditorStore
  const [undoInFlightEntryId, setUndoInFlightEntryId] = useState<string | null>(null)
  const [canUndoServer, setCanUndoServer] = useState(false)
  const [canRedoServer, setCanRedoServer] = useState(false)
  const historyInFlight = useRef(false)

  const refreshHistoryStatus = useCallback(async (slug?: string) => {
    const targetSlug = slug ?? store.getState().slug
    const session = getSessionId()
    const siteId = getSiteId()
    try {
      const res = await fetch(
        `${orchestrator}/history/status?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(targetSlug)}`
      )
      if (res.ok) {
        const data = (await res.json()) as { canUndo: boolean; canRedo: boolean }
        setCanUndoServer(data.canUndo)
        setCanRedoServer(data.canRedo)
      }
    } catch {
      // Silently ignore — status is best-effort
    }
  }, [store])

  // Refresh history status when slug changes
  const currentSlug = useEditorStore((s) => s.slug)
  useEffect(() => {
    void refreshHistoryStatus()
  }, [currentSlug, refreshHistoryStatus])

  /** Shared logic for global undo/redo operations. */
  async function applyGlobalHistoryOp(direction: "undo" | "redo") {
    const { isLoading } = store.getState()
    if (isLoading || historyInFlight.current) return
    if (direction === "undo" && !canUndoServer) return
    if (direction === "redo" && !canRedoServer) return

    historyInFlight.current = true
    try {
      const slug = store.getState().slug
      const session = getSessionId()
      const siteId = getSiteId()
      const res = await fetch(`${orchestrator}/history/${direction}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, slug })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") return

      if (data.canUndo !== undefined) setCanUndoServer(data.canUndo)
      if (data.canRedo !== undefined) setCanRedoServer(data.canRedo)

      store.getState().setActiveEditablePath(undefined)

      if (typeof data.navigateToSlug === "string" && data.navigateToSlug.length > 0) {
        store.getState().setSlug(data.navigateToSlug)
        void deps.refreshRouteSlugs()
      }

      deps.postToSite("draftUpdated", { focusBlockId: null })

      // Update chat log to reflect undo/redo state
      store.getState().setChatLog((prev) => {
        if (direction === "undo") {
          // Mark the latest undoable entry as undone
          let targetIndex = -1
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].canUndo) {
              targetIndex = i
              break
            }
          }
          if (targetIndex < 0) return prev
          const next = prev.map((entry, index) => (index === targetIndex ? { ...entry, canUndo: false, wasUndone: true } : entry))
          for (let i = targetIndex - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && next[i].status === "applied") {
              next[i] = { ...next[i], canUndo: true, wasUndone: false }
              break
            }
          }
          return next
        } else {
          // Redo: restore the most recent wasUndone entry
          let targetIndex = -1
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === "assistant" && prev[i].wasUndone) {
              targetIndex = i
              break
            }
          }
          if (targetIndex < 0) return prev
          const next = prev.map((entry, index) => (index === targetIndex ? { ...entry, canUndo: true, wasUndone: false } : entry))
          for (let i = targetIndex - 1; i >= 0; i--) {
            if (next[i].role === "assistant" && next[i].canUndo && i !== targetIndex) {
              next[i] = { ...next[i], canUndo: false }
              break
            }
          }
          return next
        }
      })
    } catch {
      // Silently ignore keyboard undo/redo failures
    } finally {
      historyInFlight.current = false
    }
  }

  async function applyUndoHistory(entryId: string) {
    const { isLoading } = store.getState()
    if (isLoading || undoInFlightEntryId) return
    setUndoInFlightEntryId(entryId)
    historyInFlight.current = true
    try {
      // Find the target entry to get its undoSlug (the slug that was affected)
      let targetUndoSlug = store.getState().slug
      const chatLog = store.getState().chatLog
      const target = chatLog.find((e) => e.id === entryId)
      if (target?.undoSlug) targetUndoSlug = target.undoSlug

      const session = getSessionId()
      const siteId = getSiteId()
      const res = await fetch(`${orchestrator}/history/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId, slug: targetUndoSlug })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") {
        store.getState().pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Could not undo.",
          changes: []
        })
        return
      }

      if (data.canUndo !== undefined) setCanUndoServer(data.canUndo)
      if (data.canRedo !== undefined) setCanRedoServer(data.canRedo)

      store.getState().setActiveEditablePath(undefined)

      // Navigate if the undo response signals a page change (e.g. after undoing create/delete)
      if (typeof data.navigateToSlug === "string" && data.navigateToSlug.length > 0) {
        store.getState().setSlug(data.navigateToSlug)
        void deps.refreshRouteSlugs()
      }

      deps.postToSite("draftUpdated", { focusBlockId: null })
      store.getState().setChatLog((prev) => {
        const targetIndex = prev.findIndex((entry) => entry.id === entryId)
        if (targetIndex < 0) return prev

        const next = prev.map((entry, index) => (index === targetIndex ? { ...entry, canUndo: false, wasUndone: true } : entry))
        let promoteIndex = -1
        for (let index = targetIndex - 1; index >= 0; index -= 1) {
          const entry = next[index]
          if (entry.role === "assistant" && entry.status === "applied") {
            promoteIndex = index
            break
          }
        }
        if (promoteIndex >= 0) next[promoteIndex] = { ...next[promoteIndex], canUndo: true, wasUndone: false }
        return next
      })
    } catch {
      store.getState().pushAssistantFromResult({
        status: "error",
        summary: "Could not undo.",
        changes: []
      })
    } finally {
      setUndoInFlightEntryId(null)
      historyInFlight.current = false
    }
  }

  // Keyboard shortcuts: Ctrl+Z / Cmd+Z for undo, Ctrl+Y / Cmd+Shift+Z for redo
  const applyGlobalUndoRef = useRef(applyGlobalHistoryOp)
  applyGlobalUndoRef.current = applyGlobalHistoryOp

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return

      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault()
        void applyGlobalUndoRef.current("undo")
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault()
        void applyGlobalUndoRef.current("redo")
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  return {
    undoInFlightEntryId,
    canUndoServer,
    canRedoServer,
    applyUndoHistory,
    applyGlobalUndo: () => applyGlobalHistoryOp("undo"),
    applyGlobalRedo: () => applyGlobalHistoryOp("redo"),
    refreshHistoryStatus,
    setCanUndoServer,
    setCanRedoServer
  }
}
