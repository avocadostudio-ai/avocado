import type { BlockInstance } from "@ai-site-editor/shared"
import { renderers } from "./blocks/index"
import { normalizeSoftHyphenEntities } from "./blocks/_shared"

export function SharedBlockRenderer({ block }: { block: BlockInstance }) {
  const Renderer = renderers[block.type]
  if (!Renderer) return null
  return <Renderer {...normalizeSoftHyphenEntities(block.props)} />
}
