import { z } from "zod"
import type { FieldKind, FieldMeta, ListFieldMeta } from "./blocks/_registry.ts"

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

export const blockDefinitionSchema = z.object({
  type: z.string().min(1),
  displayName: z.string().min(1).optional(),
  editablePaths: z.array(z.string().min(1)).optional(),
  propsSchema: jsonSchemaLikeSchema,
  defaultProps: z.record(z.string(), z.unknown()).optional()
})

export const blockManifestSchema = z.object({
  version: z.number().int().positive(),
  blocks: z.array(blockDefinitionSchema)
})

export type BlockDefinition = z.infer<typeof blockDefinitionSchema>
export type BlockManifest = z.infer<typeof blockManifestSchema>

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

// ---------------------------------------------------------------------------
// Derive FieldMeta from JSON Schema — fallback for custom blocks not in the
// shared registry. Heuristics map schema types and prop key patterns to the
// FieldKind enum so the PropertyPanel can render appropriate controls.
// ---------------------------------------------------------------------------

const IMAGE_KEY_RE = /(?:image|img)(?:Url|Src)?$|^(?:src|imageUrl|logoUrl|heroImage)$/i
const IMAGE_ALT_KEY_RE = /(?:Alt)$/

function labelFromKey(key: string): string {
  // ctaText → "CTA text", imageUrl → "Image", logoAlt → "Logo alt"
  const spaced = key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1)
  // Strip trailing "Url"/"Src" for image fields
  return label.replace(/\s*(?:Url|Src)$/i, "")
}

function inferFieldKind(key: string, schema: Record<string, unknown>): FieldKind {
  const type = typeof schema.type === "string" ? schema.type : undefined
  if (type !== "string" && type !== "number" && type !== "integer") return "text"

  if (type === "number" || type === "integer") return "number"

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum"
  if (IMAGE_ALT_KEY_RE.test(key)) return "imageAlt"
  if (IMAGE_KEY_RE.test(key)) return "image"
  return "text"
}

function deriveItemFields(itemSchema: Record<string, unknown>): Record<string, FieldMeta> {
  const fields: Record<string, FieldMeta> = {}
  const props = isObject(itemSchema.properties) ? itemSchema.properties : {}
  for (const [key, propSchema] of Object.entries(props)) {
    if (!isObject(propSchema)) continue
    const kind = inferFieldKind(key, propSchema)
    const fm: FieldMeta = { kind, label: labelFromKey(key) }
    if (kind === "enum" && Array.isArray(propSchema.enum)) {
      fm.options = propSchema.enum.filter((v): v is string => typeof v === "string")
    }
    fields[key] = fm
  }
  return fields
}

export function deriveFieldMetaFromSchema(propsSchema: Record<string, unknown>): {
  fields: Record<string, FieldMeta>
  listFields: Record<string, ListFieldMeta>
} {
  const fields: Record<string, FieldMeta> = {}
  const listFields: Record<string, ListFieldMeta> = {}

  const props = isObject(propsSchema.properties) ? propsSchema.properties : {}

  for (const [key, propSchema] of Object.entries(props)) {
    if (!isObject(propSchema)) continue
    const type = typeof propSchema.type === "string" ? propSchema.type : undefined

    // Array with object items → listFields
    if (type === "array" && isObject(propSchema.items) && (propSchema.items as Record<string, unknown>).type === "object") {
      const itemFields = deriveItemFields(propSchema.items as Record<string, unknown>)
      if (Object.keys(itemFields).length > 0) {
        listFields[key] = { label: labelFromKey(key), itemFields }
        continue
      }
    }

    // Scalar field
    const kind = inferFieldKind(key, propSchema)
    const fm: FieldMeta = { kind, label: labelFromKey(key) }
    if (kind === "enum" && Array.isArray(propSchema.enum)) {
      fm.options = propSchema.enum.filter((v): v is string => typeof v === "string")
    }
    fields[key] = fm
  }

  return { fields, listFields }
}

export function validateManifestDefaultProps(blocks: BlockDefinition[]) {
  for (const block of blocks) {
    if (!block.defaultProps) continue
    if (!validateByJsonSchemaLike(block.propsSchema, block.defaultProps)) {
      return `defaultProps do not match propsSchema for block "${block.type}"`
    }
  }
  return null
}
