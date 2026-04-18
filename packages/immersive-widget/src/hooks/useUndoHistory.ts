/**
 * Undo/redo for the immersive widget.
 *
 * Proxies to the orchestrator's snapshot-based history (/history/status,
 * /history/undo, /history/redo). History is keyed per (session, slug) —
 * undo only reverts changes to the current page.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { applyHistoryRedo, applyHistoryUndo, fetchHistoryStatus } from "../lib/widget-transport"

export type UndoHistoryState = {
  canUndo: boolean
  canRedo: boolean
  isBusy: boolean
  undo: () => Promise<void>
  redo: () => Promise<void>
  refresh: () => void
}

type Options = {
  orchestratorUrl: string
  session: string
  siteId: string
  slug: string
  onChanged: () => void
  onNavigate?: (slug: string) => void
  onStatus?: (message: string | null) => void
  /** Bumped by the caller whenever an edit lands so we can refetch status. */
  refreshKey?: number
}

export function useUndoHistory(opts: Options): UndoHistoryState {
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const { orchestratorUrl, session, siteId, slug, onChanged, onNavigate, onStatus, refreshKey } = opts

  // Keep the latest callbacks in refs so the undo/redo functions don't re-create on every render
  const onChangedRef = useRef(onChanged)
  const onNavigateRef = useRef(onNavigate)
  const onStatusRef = useRef(onStatus)
  useEffect(() => { onChangedRef.current = onChanged }, [onChanged])
  useEffect(() => { onNavigateRef.current = onNavigate }, [onNavigate])
  useEffect(() => { onStatusRef.current = onStatus }, [onStatus])

  const refreshStatus = useCallback(async () => {
    const s = await fetchHistoryStatus(orchestratorUrl, { session, siteId, slug })
    setCanUndo(s.canUndo)
    setCanRedo(s.canRedo)
  }, [orchestratorUrl, session, siteId, slug])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus, refreshKey])

  const run = useCallback(async (action: "undo" | "redo") => {
    if (isBusy) return
    setIsBusy(true)
    onStatusRef.current?.(action === "undo" ? "Undoing…" : "Redoing…")
    const fn = action === "undo" ? applyHistoryUndo : applyHistoryRedo
    const res = await fn(orchestratorUrl, { session, siteId, slug })
    setIsBusy(false)
    if (!res.ok) {
      onStatusRef.current?.(res.error ?? `${action} failed`)
      return
    }
    if (typeof res.canUndo === "boolean") setCanUndo(res.canUndo)
    if (typeof res.canRedo === "boolean") setCanRedo(res.canRedo)
    onStatusRef.current?.(null)
    if (res.navigateToSlug) {
      onNavigateRef.current?.(res.navigateToSlug)
    } else {
      onChangedRef.current?.()
    }
  }, [orchestratorUrl, session, siteId, slug, isBusy])

  const undo = useCallback(() => run("undo"), [run])
  const redo = useCallback(() => run("redo"), [run])

  return { canUndo, canRedo, isBusy, undo, redo, refresh: () => { void refreshStatus() } }
}
