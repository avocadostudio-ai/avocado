"use client"

import dynamic from "next/dynamic"
import { useState, useEffect } from "react"

const PreviewBridgeLoader = dynamic(
  () => import("./editor-overlay-inner.tsx").then((m) => ({ default: m.EditorOverlayInner })),
  { ssr: false }
)

export function EditorOverlay({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  const [inIframe, setInIframe] = useState(false)
  useEffect(() => {
    setInIframe(window.parent !== window)
  }, [])
  if (!inIframe) return null
  return <PreviewBridgeLoader slug={slug} editorOrigin={editorOrigin} />
}
