import { useCallback, useEffect, useRef, useState } from "react"
import type { PublishDiff } from "@avocadostudio-ai/shared"
import { orchestrator } from "../lib/editor-utils"

export type PublishDiffSummary = {
  added: number
  removed: number
  modified: number
  /** Whether the SiteHeader chrome (name, logo, navLabels, navGroups) changed. */
  siteConfigChanged: boolean
  /** Page added/removed/modified count + 1 if siteConfig changed. Drives the "X changes" badge. */
  total: number
}

type State = {
  summary: PublishDiffSummary | null
  isLoading: boolean
  isStale: boolean
}

export type PublishDiffSummaryResult = State & {
  /**
   * Optimistically zero the summary — call right after a successful publish so
   * the "X changes" badge clears immediately. The live-site fetch path lags
   * behind the deploy (Vercel build ~60s), so the diff endpoint would otherwise
   * keep reporting the just-published change as still pending until the deploy
   * completes. The next `revToken` bump will refetch and reconcile.
   */
  markPublished: () => void
}

/**
 * Lightweight wrapper around `/publish/diff` that returns just the page-level
 * counts (added / removed / modified). Used by the toolbar Publish button to
 * decide whether the site has unpublished changes.
 *
 * `revToken` is a monotonically-increasing counter — callers should bump it
 * whenever the draft may have changed (chat applied, restore, inline edit).
 * The fetch is debounced 600ms so rapid bumps coalesce.
 */
export function usePublishDiffSummary(
  session: string,
  siteId: string,
  siteOrigin: string | undefined,
  revToken: number
): PublishDiffSummaryResult {
  const [state, setState] = useState<State>({ summary: null, isLoading: false, isStale: false })
  const inFlightRef = useRef<AbortController | null>(null)
  // Tracks the revToken at which `markPublished()` was called. While the
  // current revToken matches, we suppress live-site fetches because the
  // deploy hasn't propagated yet.
  const publishedAtRevRef = useRef<number | null>(null)

  const markPublished = useCallback(() => {
    publishedAtRevRef.current = revToken
    inFlightRef.current?.abort()
    setState({
      summary: { added: 0, removed: 0, modified: 0, siteConfigChanged: false, total: 0 },
      isLoading: false,
      isStale: false,
    })
  }, [revToken])

  useEffect(() => {
    let cancelled = false
    // If the user just published and nothing has changed since, keep the
    // optimistic zero summary — the live site's /api/editor/pages won't
    // reflect the new deploy for ~60s and would falsely re-report the change.
    if (publishedAtRevRef.current !== null && publishedAtRevRef.current === revToken) {
      return
    }
    publishedAtRevRef.current = null

    // Mark stale immediately so the UI can dim the badge while a fresh diff loads.
    setState((prev) => (prev.summary ? { ...prev, isStale: true } : prev))

    const timer = setTimeout(() => {
      if (cancelled) return
      inFlightRef.current?.abort()
      const ac = new AbortController()
      inFlightRef.current = ac

      setState((prev) => ({ summary: prev.summary, isLoading: true, isStale: prev.isStale }))

      const params = new URLSearchParams({ session, siteId })
      if (siteOrigin) params.set("siteOrigin", siteOrigin)

      fetch(`${orchestrator}/publish/diff?${params.toString()}`, { signal: ac.signal })
        .then((res) => (res.ok ? (res.json() as Promise<PublishDiff>) : Promise.reject(new Error(`Status ${res.status}`))))
        .then((diff) => {
          if (cancelled) return
          const summary = diff.summary
          const siteConfigChanged = (summary.siteConfigChangedFields ?? 0) > 0
          setState({
            summary: {
              added: summary.pagesAdded,
              removed: summary.pagesRemoved,
              modified: summary.pagesModified,
              siteConfigChanged,
              total:
                summary.pagesAdded +
                summary.pagesRemoved +
                summary.pagesModified +
                (siteConfigChanged ? 1 : 0),
            },
            isLoading: false,
            isStale: false,
          })
        })
        .catch(() => {
          if (cancelled) return
          // Keep the prior summary so a transient failure doesn't blank the badge.
          setState((prev) => ({ summary: prev.summary, isLoading: false, isStale: prev.isStale }))
        })
    }, 600)

    return () => {
      cancelled = true
      clearTimeout(timer)
      inFlightRef.current?.abort()
    }
  }, [session, siteId, siteOrigin, revToken])

  return { ...state, markPublished }
}
