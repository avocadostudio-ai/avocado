import { SharedBlockRenderer, BlockErrorBoundary } from "@ai-site-editor/blocks"
import { getChromeTypes } from "@ai-site-editor/shared"
import { getPreviewWrapperProps } from "./editor.ts"
import type { BlockInstance } from "./types.ts"

/**
 * Renders a list of blocks with error boundaries.
 * When `editable` is true, adds preview wrapper attributes for editor overlay selection.
 */
// Chrome blocks (SiteHeader, Footer) are rendered by createSitePage — skip if present in page blocks
const CHROME_BLOCK_TYPES = new Set(getChromeTypes())

export function renderBlocks(
  blocks: BlockInstance[],
  options?: { editable?: boolean }
) {
  const editable = options?.editable ?? false
  return blocks.filter(b => !CHROME_BLOCK_TYPES.has(b.type)).map((block) => (
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
