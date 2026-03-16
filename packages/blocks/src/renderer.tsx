import type { BlockInstance } from "@ai-site-editor/shared"
import { isRendererBlockType, renderers } from "./blocks/index"
import { normalizeSoftHyphenEntities } from "./blocks/_shared"

export function SharedBlockRenderer({ block }: { block: BlockInstance }) {
  if (!isRendererBlockType(block.type)) return null
  const Renderer = renderers[block.type]
  return <Renderer {...normalizeSoftHyphenEntities(block.props)} />
}
