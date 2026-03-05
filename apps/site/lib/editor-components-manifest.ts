import {
  allowedBlockTypes,
  defaultPropsForType,
  getAllBlockMeta,
  type EditorComponentsManifest
} from "@ai-site-editor/shared"

function jsonTypeFromFieldKind(kind: string): "string" | "number" | "boolean" {
  if (kind === "number") return "number"
  return "string"
}

export function buildEditorComponentsManifest(): EditorComponentsManifest {
  const metaByType = getAllBlockMeta()
  const components: EditorComponentsManifest["components"] = []

  for (const type of allowedBlockTypes) {
    const meta = metaByType[type]
    if (!meta) continue

    const properties: Record<string, unknown> = {}
    for (const [fieldKey, fieldMeta] of Object.entries(meta.fields)) {
      if (fieldMeta.kind === "enum" && Array.isArray(fieldMeta.options) && fieldMeta.options.length > 0) {
        properties[fieldKey] = { type: "string", enum: fieldMeta.options }
        continue
      }
      properties[fieldKey] = { type: jsonTypeFromFieldKind(fieldMeta.kind) }
    }

    for (const [listKey, listMeta] of Object.entries(meta.listFields ?? {})) {
      const itemProperties: Record<string, unknown> = {}
      for (const [itemFieldKey, itemFieldMeta] of Object.entries(listMeta.itemFields)) {
        if (itemFieldMeta.kind === "enum" && Array.isArray(itemFieldMeta.options) && itemFieldMeta.options.length > 0) {
          itemProperties[itemFieldKey] = { type: "string", enum: itemFieldMeta.options }
          continue
        }
        itemProperties[itemFieldKey] = { type: jsonTypeFromFieldKind(itemFieldMeta.kind) }
      }
      properties[listKey] = {
        type: "array",
        items: {
          type: "object",
          properties: itemProperties
        }
      }
    }

    components.push({
      type,
      displayName: meta.displayName,
      propsSchema: {
        type: "object",
        properties
      },
      defaultProps: defaultPropsForType(type)
    })
  }

  return {
    version: 1,
    components
  }
}
