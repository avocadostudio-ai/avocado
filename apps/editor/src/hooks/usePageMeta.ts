import { useCallback, useEffect, useRef, useState } from "react"
import type { PageMeta } from "@avocadostudio-ai/shared"
import { orchestrator } from "../lib/editor-utils"

export type PageMetaResult = {
  status: "idle" | "loading" | "ready" | "error"
  meta: PageMeta
  setMeta: (meta: PageMeta) => void
  refetch: () => void
}

export function usePageMeta(
  session: string,
  siteId: string,
  slug: string,
  enabled: boolean
): PageMetaResult {
  const [status, setStatus] = useState<PageMetaResult["status"]>("idle")
  const [meta, setMetaState] = useState<PageMeta>({})
  const abortRef = useRef<AbortController | null>(null)
  const metaJsonRef = useRef<string>("")

  const doFetch = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus("loading")
    try {
      const url = `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" })
      if (!res.ok) {
        setStatus("error")
        return
      }
      const data = (await res.json()) as { meta?: PageMeta }
      const nextMeta = data.meta ?? {}
      const json = JSON.stringify(nextMeta)
      if (json !== metaJsonRef.current) {
        metaJsonRef.current = json
        setMetaState(nextMeta)
      }
      setStatus("ready")
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setStatus("error")
    }
  }, [session, siteId, slug])

  useEffect(() => {
    if (enabled) void doFetch()
    return () => { abortRef.current?.abort() }
  }, [doFetch, enabled])

  const setMeta = useCallback((next: PageMeta) => {
    metaJsonRef.current = JSON.stringify(next ?? {})
    setMetaState(next ?? {})
  }, [])

  return { status, meta, setMeta, refetch: doFetch }
}
