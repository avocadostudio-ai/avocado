import { PreviewBridge } from "@ai-site-editor/preview-adapter"

export function EditorPreviewBridge({ slug, editorOrigin }: { slug: string; editorOrigin: string }) {
  return <PreviewBridge slug={slug} editorOrigin={editorOrigin} />
}
