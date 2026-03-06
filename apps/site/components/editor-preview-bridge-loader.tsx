"use client"

import dynamic from "next/dynamic"

const EditorPreviewBridge = dynamic(
  () => import("./editor-harness").then((m) => ({ default: m.EditorPreviewBridge })),
  { ssr: false }
)

export function EditorPreviewBridgeLoader({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  return <EditorPreviewBridge slug={slug} editorOrigin={editorOrigin} />
}
