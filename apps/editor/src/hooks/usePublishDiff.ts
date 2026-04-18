import { useEffect, useState } from "react"
import type { PublishDiff } from "@ai-site-editor/shared"
import { orchestrator } from "../lib/editor-utils"

type State = {
  diff: PublishDiff | null
  isLoading: boolean
  error: string | null
}

/**
 * Fetches the publish diff from the orchestrator when `enabled` flips true.
 * Keyed on (session, siteId, siteOrigin) so switching sites refetches.
 *
 * `siteOrigin` is forwarded so the orchestrator can fetch the authoritative
 * published pages from the live site rather than its in-memory demo seed.
 */
export function usePublishDiff(enabled: boolean, session: string, siteId: string, siteOrigin?: string): State {
  const [state, setState] = useState<State>({ diff: null, isLoading: false, error: null })

  useEffect(() => {
    if (!enabled) {
      setState({ diff: null, isLoading: false, error: null })
      return
    }
    let cancelled = false
    setState({ diff: null, isLoading: true, error: null })
    const params = new URLSearchParams({ session, siteId })
    if (siteOrigin) params.set("siteOrigin", siteOrigin)
    const url = `${orchestrator}/publish/diff?${params.toString()}`
    fetch(url)
      .then((res) => res.ok ? res.json() as Promise<PublishDiff> : Promise.reject(new Error(`Status ${res.status}`)))
      .then((diff) => { if (!cancelled) setState({ diff, isLoading: false, error: null }) })
      .catch((err: unknown) => { if (!cancelled) setState({ diff: null, isLoading: false, error: String(err) }) })
    return () => { cancelled = true }
  }, [enabled, session, siteId, siteOrigin])

  return state
}
