import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react"
import { applyLiveDraftToPuckData, pageToPuckData } from "./adapters"
import { fetchDraftPage, fetchDraftSlugs } from "./draft-api"
import type { PuckData } from "./types"

type UsePuckSiteSyncArgs = {
  session: string
  siteId: string
  slugRef: RefObject<string>
  setSlug: (slug: string) => void
  setAvailableSlugs: (slugs: string[] | ((prev: string[]) => string[])) => void
  puckDispatchRef: MutableRefObject<((action: any) => void) | null>
  setPuckData: Dispatch<SetStateAction<PuckData | null>>
  onRemoteData?: (data: PuckData) => void
}

export function usePuckSiteSync({
  session,
  siteId,
  slugRef,
  setSlug,
  setAvailableSlugs,
  puckDispatchRef,
  setPuckData,
  onRemoteData,
}: UsePuckSiteSyncArgs) {
  const syncDraftPage = useCallback(async (targetSlug: string) => {
    const page = await fetchDraftPage(session, siteId, targetSlug)
    const nextData = pageToPuckData(page)
    if (puckDispatchRef.current) {
      puckDispatchRef.current({ type: "setData", data: nextData })
    }
    setPuckData(nextData)
    onRemoteData?.(nextData)
  }, [session, siteId, puckDispatchRef, setPuckData, onRemoteData])

  const postToSite = useCallback((
    type: "highlightBlock" | "draftUpdated" | "setNestedLabelsVisibility" | "liveDraft" | "showSkeleton" | "removeSkeleton" | "aiFieldLoading",
    payload: Record<string, unknown>
  ) => {
    if (type === "liveDraft") {
      const blockId = typeof payload.blockId === "string" ? payload.blockId : ""
      const rawFields = payload.fields
      if (!blockId || !rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) return

      setPuckData((prev) => {
        if (!prev) return prev
        const next = applyLiveDraftToPuckData(prev, blockId, rawFields as Record<string, unknown>)
        if (next !== prev && puckDispatchRef.current) {
          puckDispatchRef.current({ type: "setData", data: next })
        }
        return next
      })
      return
    }

    if (type !== "draftUpdated") return
    const navigateTo = typeof payload.navigateTo === "string" && payload.navigateTo.length > 0
      ? payload.navigateTo
      : slugRef.current
    if (navigateTo !== slugRef.current) {
      setSlug(navigateTo)
      // Optimistically add the new slug so the selector shows it before the fetch completes.
      setAvailableSlugs((prev: string[]) => prev.includes(navigateTo) ? prev : [...prev, navigateTo])
    }

    // Refresh slug list from server — handles creates, deletes, and renames.
    void fetchDraftSlugs(session, siteId).then(setAvailableSlugs).catch(() => undefined)
    void syncDraftPage(navigateTo).catch(() => undefined)
  }, [session, siteId, setPuckData, puckDispatchRef, slugRef, setSlug, setAvailableSlugs, syncDraftPage])

  const postPatchToSite = useCallback((
    _op: unknown,
    _fromVersion: number,
    _toVersion: number,
    _focusBlockId?: string
  ) => {
    void syncDraftPage(slugRef.current).catch(() => undefined)
  }, [slugRef, syncDraftPage])

  return {
    postToSite,
    postPatchToSite,
    syncDraftPage,
  }
}
