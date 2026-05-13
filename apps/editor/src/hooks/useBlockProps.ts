import { useCallback, useEffect, useRef, useState } from "react"
import { orchestrator } from "../lib/editor-utils"
import type { BlockInstance } from "@avocadostudio-ai/shared"

export type BlockPropsResult = {
  status: "idle" | "loading" | "ready" | "error"
  props: Record<string, unknown> | null
  blockType: string | null
  refetch: () => void
}

const RETRY_DELAY_MS = 1200
const MAX_RETRIES = 2

export function useBlockProps(
  session: string,
  siteId: string,
  slug: string,
  activeBlockId: string | undefined,
  enabled: boolean
): BlockPropsResult {
  const [status, setStatus] = useState<BlockPropsResult["status"]>("idle")
  const [props, setProps] = useState<Record<string, unknown> | null>(null)
  const [blockType, setBlockType] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const propsJsonRef = useRef<string>("")
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const doFetch = useCallback(async (retry = false) => {
    if (!activeBlockId) {
      setStatus("idle")
      setProps(null)
      setBlockType(null)
      propsJsonRef.current = ""
      retryCountRef.current = 0
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    if (!retry) retryCountRef.current = 0
    setStatus("loading")
    try {
      const url = `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" })
      if (!res.ok) {
        // Draft not found — bootstrap may still be in progress, retry
        if (retryCountRef.current < MAX_RETRIES) {
          retryCountRef.current++
          retryTimerRef.current = setTimeout(() => { void doFetch(true) }, RETRY_DELAY_MS)
          return
        }
        setStatus("error")
        return
      }
      const data = (await res.json()) as { blocks?: BlockInstance[] }
      const blocks = data.blocks ?? []
      const block = blocks.find((b) => b.id === activeBlockId)
      if (block) {
        const json = JSON.stringify(block.props)
        if (json !== propsJsonRef.current) {
          propsJsonRef.current = json
          setProps(block.props)
        }
        setBlockType(block.type)
        setStatus("ready")
        retryCountRef.current = 0
      } else {
        // Block ID not found in page — bootstrap may not have synced yet, retry
        if (retryCountRef.current < MAX_RETRIES) {
          retryCountRef.current++
          retryTimerRef.current = setTimeout(() => { void doFetch(true) }, RETRY_DELAY_MS)
          return
        }
        propsJsonRef.current = ""
        setProps(null)
        setBlockType(null)
        setStatus("error")
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      if (retryCountRef.current < MAX_RETRIES) {
        retryCountRef.current++
        retryTimerRef.current = setTimeout(() => { void doFetch(true) }, RETRY_DELAY_MS)
        return
      }
      setStatus("error")
    }
  }, [session, siteId, slug, activeBlockId])

  // Auto-fetch when deps change, gated on `enabled`
  useEffect(() => {
    if (enabled) void doFetch()
    return () => {
      abortRef.current?.abort()
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [doFetch, enabled])

  // refetch is always callable — not gated on `enabled`
  return { status, props, blockType, refetch: doFetch }
}
