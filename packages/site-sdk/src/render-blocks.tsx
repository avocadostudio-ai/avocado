import { SharedBlockRenderer, BlockErrorBoundary } from "@ai-site-editor/blocks"
import { getPreviewWrapperProps } from "./editor.ts"
import type { BlockInstance } from "./types.ts"

/**
 * Renders a list of blocks with error boundaries.
 * When `editable` is true, adds preview wrapper attributes for editor overlay selection.
 */
export function renderBlocks(
  blocks: BlockInstance[],
  options?: { editable?: boolean }
) {
  const editable = options?.editable ?? false
  return blocks.map((block) => (
    <div
      key={block.id}
      id={block.id}
      {...(editable ? getPreviewWrapperProps(true, block.id, block.type) : {})}
    >
      <BlockErrorBoundary blockId={block.id} blockType={block.type}>
        <SharedBlockRenderer block={block} />
      </BlockErrorBoundary>
    </div>
  ))
}
