import { getBlockJsonSchema, getBlockMeta, allowedBlockTypes, defaultPropsForType } from "@ai-site-editor/shared"
import {
  editorComponentSchema,
  editorComponentsManifestSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
} from "@ai-site-editor/shared"

export {
  editorComponentSchema,
  editorComponentsManifestSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
}

// --- Manifest builder (cached) ---

let cachedManifest: EditorComponentsManifest | undefined

export function buildComponentsManifest(): EditorComponentsManifest {
  if (cachedManifest) return cachedManifest
  const components: EditorComponentDefinition[] = allowedBlockTypes.map((type) => {
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
  cachedManifest = { version: 1, components }
  return cachedManifest
}
