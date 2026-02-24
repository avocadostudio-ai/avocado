import { getPreviewWrapperProps } from "@ai-site-editor/preview-adapter"

export type EditorBlockWrapperProps = ReturnType<typeof getPreviewWrapperProps>

export function getEditorBlockWrapperProps(editorMode: boolean, blockId: string, blockType: string): EditorBlockWrapperProps {
  return getPreviewWrapperProps(editorMode, blockId, blockType)
}
