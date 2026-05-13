import type { JSX } from "react"
import type { BlockInstance } from "@avocadostudio-ai/shared"
import { isRendererBlockType, renderers } from "./blocks/index"
import { normalizeSoftHyphenEntities } from "./blocks/_shared"

export type BlockRenderer = (props: Record<string, unknown>) => JSX.Element | null

// Custom renderers registered by site-specific blocks (e.g. migration-generated blocks).
// Use globalThis to ensure a single Map instance survives Next.js webpack module duplication
// across RSC / SSR / client layers — without this, registerCustomRenderer and getCustomRenderer
// may reference different Map copies and custom blocks render as empty.
const GLOBAL_KEY = "__ai_site_editor_custom_renderers__" as const
const customRenderers: Map<string, BlockRenderer> =
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, BlockRenderer>) ??
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] = new Map<string, BlockRenderer>())

/** Register a custom block renderer (for site-specific blocks not in the standard library). */
export function registerCustomRenderer(blockType: string, renderer: BlockRenderer) {
  customRenderers.set(blockType, renderer)
}

/** Check if a block type has a renderer (standard or custom). */
export function hasRenderer(blockType: string): boolean {
  return isRendererBlockType(blockType) || customRenderers.has(blockType)
}

/** Get a custom renderer by block type (for server-side resolution before client boundary). */
export function getCustomRenderer(blockType: string): BlockRenderer | undefined {
  return customRenderers.get(blockType)
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
