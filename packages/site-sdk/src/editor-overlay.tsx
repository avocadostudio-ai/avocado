"use client"

import dynamic from "next/dynamic"

const PreviewBridgeLoader = dynamic(
  () => import("./editor-overlay-inner.tsx").then((m) => ({ default: m.EditorOverlayInner })),
  { ssr: false }
)

export function EditorOverlay({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  return <PreviewBridgeLoader slug={slug} editorOrigin={editorOrigin} />
}
