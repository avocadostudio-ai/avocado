import { SharedBlockRenderer, BlockErrorBoundary, getCustomRenderer } from "@avocadostudio-ai/blocks"
import { getChromeTypes } from "@avocadostudio-ai/shared"
import { getPreviewWrapperProps } from "./editor.ts"
import type { BlockInstance } from "./types.ts"

/**
 * Renders a list of blocks with error boundaries.
 * When `editable` is true, adds preview wrapper attributes for editor overlay selection.
 *
 * Custom renderers (registered via registerCustomRenderer) are resolved here on the
 * server side, then passed directly to the client-side BlockErrorBoundary. This avoids
 * the RSC boundary issue where the customRenderers Map is empty on the client.
 */
// Chrome blocks (SiteHeader, Footer) are rendered by createSitePage — skip if present in page blocks
const CHROME_BLOCK_TYPES = new Set(getChromeTypes())

export function renderBlocks(
  blocks: BlockInstance[],
  options?: { editable?: boolean }
) {
  const editable = options?.editable ?? false
  return blocks.filter(b => !CHROME_BLOCK_TYPES.has(b.type)).map((block) => {
    // Resolve custom renderer on the server side (where registerCustomRenderer ran).
    // Custom renderers are "use client" components — passing them as JSX from a server
    // component works correctly across the RSC boundary (React serializes the reference).
    const CustomRenderer = getCustomRenderer(block.type)

    return (
      <div
        key={block.id}
        id={block.id}
        {...(editable ? getPreviewWrapperProps(true, block.id, block.type) : {})}
      >
        <BlockErrorBoundary blockId={block.id} blockType={block.type}>
          {CustomRenderer
            ? <CustomRenderer {...block.props} />
            : <SharedBlockRenderer block={block} />}
        </BlockErrorBoundary>
      </div>
    )
  })
}
