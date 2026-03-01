import type { BlockInstance } from "@ai-site-editor/shared"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { getEditorBlockWrapperProps } from "../lib/editor-block-wrapper"
import { BlockErrorBoundary } from "./block-error-boundary"

export function BlockRenderer({ block, editorMode }: { block: BlockInstance; editorMode: boolean }) {
  const previewWrapperProps = getEditorBlockWrapperProps(editorMode, block.id, block.type)
  return (
    <div {...previewWrapperProps}>
      <BlockErrorBoundary blockId={block.id} blockType={block.type}>
        <SharedBlockRenderer block={block} />
      </BlockErrorBoundary>
    </div>
  )
}
