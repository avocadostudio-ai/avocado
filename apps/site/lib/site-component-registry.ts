import { getBlockJsonSchema, getBlockMeta, allowedBlockTypes, defaultPropsForType } from "@ai-site-editor/shared"
import type { EditorComponentDefinition } from "./editor-components-contract"

function buildComponents(): EditorComponentDefinition[] {
  return allowedBlockTypes.map((type) => {
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
}

export function getSiteComponentRegistry() {
  return buildComponents()
}
