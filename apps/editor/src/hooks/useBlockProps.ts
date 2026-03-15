import { useCallback, useEffect, useRef, useState } from "react"
import { orchestrator } from "../lib/editor-utils"
import type { BlockInstance } from "@ai-site-editor/shared"

export type BlockPropsResult = {
  status: "idle" | "loading" | "ready" | "error"
  props: Record<string, unknown> | null
  refetch: () => void
}

export function useBlockProps(
  session: string,
  siteId: string,
  slug: string,
  activeBlockId: string | undefined,
  enabled: boolean
): BlockPropsResult {
  const [status, setStatus] = useState<BlockPropsResult["status"]>("idle")
  const [props, setProps] = useState<Record<string, unknown> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const propsJsonRef = useRef<string>("")

  const fetchProps = useCallback(async () => {
    if (!activeBlockId || !enabled) {
      setStatus("idle")
      setProps(null)
      propsJsonRef.current = ""
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setStatus("loading")
    try {
      const url = `${orchestrator}/draft/pages?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}&slug=${encodeURIComponent(slug)}`
      const res = await fetch(url, { signal: controller.signal })
      if (!res.ok) {
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
        setStatus("ready")
      } else {
        propsJsonRef.current = ""
        setProps(null)
        setStatus("idle")
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setStatus("error")
    }
  }, [session, siteId, slug, activeBlockId, enabled])

  useEffect(() => {
    void fetchProps()
    return () => { abortRef.current?.abort() }
  }, [fetchProps])

  return { status, props, refetch: fetchProps }
}
