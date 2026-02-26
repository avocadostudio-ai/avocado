import type { BlockInstance } from "@ai-site-editor/shared"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { getEditorBlockWrapperProps } from "../lib/editor-block-wrapper"

export function BlockRenderer({ block, editorMode }: { block: BlockInstance; editorMode: boolean }) {
  const previewWrapperProps = getEditorBlockWrapperProps(editorMode, block.id, block.type)
  return (
    <div {...previewWrapperProps}>
      <SharedBlockRenderer block={block} />
    </div>
  )
}
