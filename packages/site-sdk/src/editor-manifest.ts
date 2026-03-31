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

// --- Manifest builder ---
// Built fresh each time to include custom blocks registered after initial load.
// Custom site blocks call registerBlock() in their schema.ts (imported via blocks/register.ts),
// which adds them to allowedBlockTypes. The manifest must reflect ALL registered blocks,
// not just the standard library ones.

export function buildBlockManifest(): BlockManifest {
  const blocks: BlockDefinition[] = allowedBlockTypes
    .map((type) => {
      const meta = getBlockMeta(type)
      const propsSchema = getBlockJsonSchema(type)
      if (!propsSchema) return null // skip blocks without schema (shouldn't happen but be safe)
      return {
        type,
        displayName: meta?.displayName ?? type,
        propsSchema: propsSchema as Record<string, unknown>,
        defaultProps: defaultPropsForType(type)
      }
    })
    .filter((b) => b !== null) as BlockDefinition[]
  return { version: 1, blocks }
}
