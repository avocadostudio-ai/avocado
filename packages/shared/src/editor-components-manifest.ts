import { z } from "zod"

export const jsonSchemaLikeSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.object({
    type: z.string().optional(),
    properties: z.record(z.string(), jsonSchemaLikeSchema).optional(),
    required: z.array(z.string()).optional(),
    items: z.union([jsonSchemaLikeSchema, z.array(jsonSchemaLikeSchema)]).optional(),
    enum: z.array(z.unknown()).optional(),
    anyOf: z.array(jsonSchemaLikeSchema).optional(),
    oneOf: z.array(jsonSchemaLikeSchema).optional(),
    allOf: z.array(jsonSchemaLikeSchema).optional(),
    additionalProperties: z.union([z.boolean(), jsonSchemaLikeSchema]).optional(),
    description: z.string().optional()
  }).catchall(z.unknown())
)

export const editorComponentSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1).optional(),
  editablePaths: z.array(z.string().min(1)).optional(),
  propsSchema: jsonSchemaLikeSchema,
  defaultProps: z.record(z.string(), z.unknown()).optional()
})

export const editorComponentsManifestSchema = z.object({
  version: z.number().int().positive(),
  components: z.array(editorComponentSchema)
})

export type EditorComponentDefinition = z.infer<typeof editorComponentSchema>
export type EditorComponentsManifest = z.infer<typeof editorComponentsManifestSchema>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function validateByJsonSchemaLike(schema: Record<string, unknown>, value: unknown): boolean {
  const type = typeof schema.type === "string" ? schema.type : undefined
  if (type === "object") {
    if (!isObject(value)) return false
    const props = isObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    for (const key of required) {
      if (!(key in value)) return false
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in value)) continue
      if (!isObject(propSchema)) continue
      if (!validateByJsonSchemaLike(propSchema, value[key])) return false
    }
    return true
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false
    const items = schema.items
    if (isObject(items)) return value.every((item) => validateByJsonSchemaLike(items, item))
    return true
  }
  if (type === "string") return typeof value === "string"
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value)
  if (type === "boolean") return typeof value === "boolean"
  return true
}

export function validateManifestDefaultProps(components: EditorComponentDefinition[]) {
  for (const component of components) {
    if (!component.defaultProps) continue
    if (!validateByJsonSchemaLike(component.propsSchema, component.defaultProps)) {
      return `defaultProps do not match propsSchema for component "${component.type}"`
    }
  }
  return null
}
