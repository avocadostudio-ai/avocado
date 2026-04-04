import { useState } from "react"
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

  async function applyUndoHistory(entryId: string) {
    const { isLoading } = store.getState()
    if (isLoading || undoInFlightEntryId) return
    setUndoInFlightEntryId(entryId)
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
    }
  }

  return {
    undoInFlightEntryId,
    applyUndoHistory
  }
}
