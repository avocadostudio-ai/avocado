import type { JSX } from "react"
import type { BlockInstance } from "@ai-site-editor/shared"
import { isRendererBlockType, renderers } from "./blocks/index"
import { normalizeSoftHyphenEntities } from "./blocks/_shared"

export type BlockRenderer = (props: Record<string, unknown>) => JSX.Element | null

// Custom renderers registered by site-specific blocks (e.g. migration-generated blocks)
const customRenderers = new Map<string, BlockRenderer>()

/** Register a custom block renderer (for site-specific blocks not in the standard library). */
export function registerCustomRenderer(blockType: string, renderer: BlockRenderer) {
  customRenderers.set(blockType, renderer)
}

/** Check if a block type has a renderer (standard or custom). */
export function hasRenderer(blockType: string): boolean {
  return isRendererBlockType(blockType) || customRenderers.has(blockType)
}

export function SharedBlockRenderer({ block }: { block: BlockInstance }) {
  const props = normalizeSoftHyphenEntities(block.props)

  // Try standard renderer first
  if (isRendererBlockType(block.type)) {
    const Renderer = renderers[block.type]
    return <Renderer {...props} />
  }

  // Fall back to custom renderer
  const Custom = customRenderers.get(block.type)
  if (Custom) return <Custom {...props} />

  return null
}
