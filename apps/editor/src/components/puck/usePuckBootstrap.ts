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

  const loadManifestAndSlugs = useCallback(async () => {
    const [nextManifest, slugs] = await Promise.all([
      fetchManifest(),
      fetchDraftSlugs(session, siteId),
    ])

    setManifest(nextManifest)
    setAvailableSlugs(slugs)
    if (!slugs.includes(slug)) setSlug(slugs[0])
  }, [session, siteId, slug, setSlug])

  const loadPage = useCallback(async (nextSlug: string) => {
    const loadSeq = ++latestLoadSeqRef.current
    const page = await fetchDraftPage(session, siteId, nextSlug)
    if (loadSeq !== latestLoadSeqRef.current) return
    setPuckData(pageToPuckData(page))
    setRemotePuckVersion((v) => v + 1)
  }, [session, siteId])

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
        await loadPage(slug)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : "Failed to load Puck prototype")
      } finally {
        if (!cancelled) setIsBusy(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [ensureDraftInitialized, loadManifestAndSlugs, loadPage, slug])

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
