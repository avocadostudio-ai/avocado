"use client"

import dynamic from "next/dynamic"

const PreviewBridgeLoader = dynamic(
  () => import("./editor-overlay-inner.tsx").then((m) => ({ default: m.EditorOverlayInner })),
  { ssr: false }
)

export function EditorOverlay({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  // Skip when not embedded in an iframe (page opened directly in browser)
  if (typeof window !== "undefined" && window.parent === window) return null
  return <PreviewBridgeLoader slug={slug} editorOrigin={editorOrigin} />
}
