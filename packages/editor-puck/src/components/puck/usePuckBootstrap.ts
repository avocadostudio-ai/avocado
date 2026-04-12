import { useCallback, useEffect, useRef, useState } from "react"
import type { BlockManifest, PageDoc } from "@ai-site-editor/shared"
import { FALLBACK_SLUG } from "./constants"
import { pageToPuckData } from "./adapters"
import { bootstrapDraft, fetchDraftPage, fetchDraftSlugs, fetchEditorPages, fetchManifest } from "./draft-api"
import type { PuckData } from "./types"

type UsePuckBootstrapArgs = {
  session: string
  siteId: string
  slug: string
  setSlug: (slug: string) => void
}

export function usePuckBootstrap({ session, siteId, slug, setSlug }: UsePuckBootstrapArgs) {
  const [manifest, setManifest] = useState<BlockManifest | null>(null)
  const [puckData, setPuckData] = useState<PuckData | null>(null)
  const [remotePuckVersion, setRemotePuckVersion] = useState(0)
  const [availableSlugs, setAvailableSlugs] = useState<string[]>([FALLBACK_SLUG])
  const [isLoadingSlugs, setIsLoadingSlugs] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latestLoadSeqRef = useRef(0)

  const ensureDraftInitialized = useCallback(async () => {
    let pages: PageDoc[] = []
    try {
      pages = await fetchEditorPages(siteId)
    } catch {
      // Keep bootstrapping best-effort: orchestrator may already have draft pages.
    }

    await bootstrapDraft(session, siteId, pages)
  }, [session, siteId])

  const slugRef = useRef(slug)
  slugRef.current = slug

  const loadManifestAndSlugs = useCallback(async () => {
    const [nextManifest, slugs] = await Promise.all([
      fetchManifest(),
      fetchDraftSlugs(session, siteId),
    ])

    setManifest(nextManifest)
    setAvailableSlugs(slugs)
    if (!slugs.includes(slugRef.current)) setSlug(slugs[0])
  }, [session, siteId, setSlug])

  const loadPage = useCallback(async (nextSlug: string) => {
    const loadSeq = ++latestLoadSeqRef.current
    const page = await fetchDraftPage(session, siteId, nextSlug)
    if (loadSeq !== latestLoadSeqRef.current) return
    setPuckData(pageToPuckData(page))
    setRemotePuckVersion((v) => v + 1)
  }, [session, siteId])

  // Does NOT re-run on slug changes — handled by the effect below.
  const bootstrapDoneRef = useRef(false)
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setError(null)
      setIsBusy(true)
      try {
        await ensureDraftInitialized()
        if (cancelled) return
        await loadManifestAndSlugs()
        if (cancelled) return
        await loadPage(slugRef.current)
        bootstrapDoneRef.current = true
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load Puck prototype")
      } finally {
        if (!cancelled) setIsBusy(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [ensureDraftInitialized, loadManifestAndSlugs, loadPage])

  // Re-fetch page on slug change (covers manual page-selector navigation).
  useEffect(() => {
    if (!bootstrapDoneRef.current) return
    setError(null)
    void loadPage(slug).catch(() => undefined)
  }, [loadPage, slug])

  return {
    manifest,
    puckData,
    setPuckData,
    remotePuckVersion,
    availableSlugs,
    setAvailableSlugs,
    isLoadingSlugs,
    setIsLoadingSlugs,
    isBusy,
    error,
  }
}
