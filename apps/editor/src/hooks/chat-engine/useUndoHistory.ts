import { useState } from "react"
import type { AssistantResponse, ChatEntry, HistoryResponse } from "../../lib/editor-types"
import { orchestrator } from "../../lib/editor-utils"

export type UndoHistoryDeps = {
  session: string
  siteId: string
  slugRef: React.RefObject<string>
  isLoading: boolean
  activeEditablePathRef: React.RefObject<string | undefined>
  setActiveEditablePath: (value: string | undefined) => void
  postToSite: (type: "draftUpdated", payload: Record<string, unknown>) => void
  setChatLog: React.Dispatch<React.SetStateAction<ChatEntry[]>>
  pushAssistantFromResult: (data: AssistantResponse, options?: { canUndo?: boolean }) => void
}

export function useUndoHistory(deps: UndoHistoryDeps) {
  const [undoInFlightEntryId, setUndoInFlightEntryId] = useState<string | null>(null)

  async function applyUndoHistory(entryId: string) {
    if (deps.isLoading || undoInFlightEntryId) return
    setUndoInFlightEntryId(entryId)
    try {
      const res = await fetch(`${orchestrator}/history/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: deps.session, siteId: deps.siteId, slug: deps.slugRef.current })
      })
      const data = (await res.json()) as HistoryResponse
      if (!res.ok || data.status !== "applied") {
        deps.pushAssistantFromResult({
          status: "error",
          summary: data.error ?? "Could not undo.",
          changes: []
        })
        return
      }

      deps.activeEditablePathRef.current = undefined
      deps.setActiveEditablePath(undefined)
      deps.postToSite("draftUpdated", { focusBlockId: null })
      deps.setChatLog((prev) => {
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
      deps.pushAssistantFromResult({
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
