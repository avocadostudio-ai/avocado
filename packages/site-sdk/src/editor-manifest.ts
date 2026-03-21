import { getBlockJsonSchema, getBlockMeta, allowedBlockTypes, defaultPropsForType } from "@ai-site-editor/shared"
import {
  blockDefinitionSchema,
  blockManifestSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type BlockDefinition,
  type BlockManifest
} from "@ai-site-editor/shared"

export {
  blockDefinitionSchema,
  blockManifestSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type BlockDefinition,
  type BlockManifest
}

// --- Manifest builder (cached) ---

let cachedManifest: BlockManifest | undefined

export function buildBlockManifest(): BlockManifest {
  if (cachedManifest) return cachedManifest
  const blocks: BlockDefinition[] = allowedBlockTypes.map((type) => {
    const meta = getBlockMeta(type)
    const propsSchema = getBlockJsonSchema(type)
    if (!propsSchema) throw new Error(`Missing JSON schema for block type: ${type}`)
    return {
      type,
      displayName: meta?.displayName ?? type,
      propsSchema: propsSchema as Record<string, unknown>,
      defaultProps: defaultPropsForType(type)
    }
  })
  cachedManifest = { version: 1, blocks }
  return cachedManifest
}
