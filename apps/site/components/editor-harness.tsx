"use client"

import "@ai-site-editor/preview-adapter/styles.css"
import { PreviewBridge } from "@ai-site-editor/preview-adapter"

export function EditorPreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  return <PreviewBridge slug={slug} editorOrigin={editorOrigin} />
}
