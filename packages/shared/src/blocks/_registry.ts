import { z } from "zod"

// ---------------------------------------------------------------------------
// Field & block metadata types
// ---------------------------------------------------------------------------

/** Semantic kind for a block prop field. */
export type FieldKind = "text" | "richtext" | "url" | "image" | "imageAlt" | "enum" | "color" | "number" | "headingLevel"

/** Recommended image dimensions for an image field. */
export type ImageSpec = {
  aspectRatio: "landscape" | "square" | "portrait"
  width: number
  height: number
  format?: "png" | "webp" | "jpeg"
}

/** Metadata for a single prop field on a block. */
export type FieldMeta = {
  kind: FieldKind
  /** Human-readable label (e.g. "Heading text"). Falls back to prop key. */
  label?: string
  /** Whether this field supports inline editing in the preview. Defaults based on kind. */
  inlineEditable?: boolean
  /** For enum kind: the allowed values. */
  options?: string[]
  /** For image kind: recommended dimensions and aspect ratio. */
  imageSpec?: ImageSpec
  /** Render as a textarea in the PropertyPanel instead of a single-line input. */
  multiline?: boolean
  /** Whether the field is required. Auto-derived from Zod schema at registration. */
  required?: boolean
}

/** Metadata for list-type props (features, items, cards). */
export type ListFieldMeta = {
  /** Display label for the list (e.g. "Features"). */
  label?: string
  /** Field metadata for each item in the list. */
  itemFields: Record<string, FieldMeta>
}

/** Full metadata for a registered block type. */
export type BlockMeta = {
  displayName: string
  description?: string
  category?: "content" | "media" | "navigation" | "conversion" | "layout"
  /** Chrome blocks (header/footer) are structurally pinned — not addable, movable, or removable. Editable via props only. */
  chrome?: boolean
  /** Metadata for scalar (non-list) props. */
  fields: Record<string, FieldMeta>
  /** Metadata for array/list props. */
  listFields?: Record<string, ListFieldMeta>
}

// ---------------------------------------------------------------------------
// Core block types
// ---------------------------------------------------------------------------

export type BlockType = string & {}

export type BlockInstance = {
  id: string
  type: BlockType
  props: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Block registry
// ---------------------------------------------------------------------------

const _blockSchemas: Record<string, z.ZodObject<any>> = {}
const _blockMeta: Record<string, BlockMeta> = {}

export type BlockRegistration = {
  schema: z.ZodObject<any>
  meta: BlockMeta
}

/**
 * Register a block type. Can be called at module load time.
 * Re-registering the same type overwrites the previous registration.
 */
export function registerBlock(type: string, config: BlockRegistration) {
  _blockSchemas[type] = config.schema

  // Auto-derive `required` on each FieldMeta from the Zod schema shape
  const shape = config.schema.shape as Record<string, z.ZodTypeAny> | undefined
  if (shape) {
    for (const [key, field] of Object.entries(config.meta.fields)) {
      if (field.required !== undefined) continue // explicit override
      const zodField = shape[key]
      if (zodField) {
        field.required = !zodField.isOptional()
      }
    }
    // List item fields
    if (config.meta.listFields) {
      for (const [listKey, listMeta] of Object.entries(config.meta.listFields)) {
        const listZod = shape[listKey]
        // Unwrap ZodArray → element (ZodObject)
        const elementShape = (listZod as any)?.element?.shape as Record<string, z.ZodTypeAny> | undefined
        if (!elementShape) continue
        for (const [itemKey, itemField] of Object.entries(listMeta.itemFields)) {
          if (itemField.required !== undefined) continue
          const zodItem = elementShape[itemKey]
          if (zodItem) {
            itemField.required = !zodItem.isOptional()
          }
        }
      }
    }
  }

  _blockMeta[type] = config.meta

  if (!config.meta.chrome && !allowedBlockTypes.includes(type)) {
    allowedBlockTypes.push(type)
  }
}

/** Get metadata for a registered block type, or undefined. */
export function getBlockMeta(type: string): BlockMeta | undefined {
  return _blockMeta[type]
}

/** Get all registered block metadata. */
export function getAllBlockMeta(): Readonly<Record<string, BlockMeta>> {
  return _blockMeta
}

/** Check if a block type is a chrome block (structurally pinned). */
export function isChrome(type: string): boolean {
  return _blockMeta[type]?.chrome === true
}

/** Get all registered chrome block type names. */
export function getChromeTypes(): string[] {
  return Object.entries(_blockMeta).filter(([, meta]) => meta.chrome).map(([type]) => type)
}

/** Check if a field is inline-editable based on its metadata kind. */
export function isFieldInlineEditable(type: string, fieldPath: string): boolean {
  const meta = _blockMeta[type]
  if (!meta) return true // no metadata = allow (backwards compat)

  // Handle nested paths like "features[0].title" → list "features", item field "title"
  const listMatch = fieldPath.match(/^([a-zA-Z_]+)\[\d+\]\.(.+)$/)
  if (listMatch) {
    const [, listKey, itemField] = listMatch
    const listMeta = meta.listFields?.[listKey]
    if (!listMeta) return true
    const fm = listMeta.itemFields[itemField]
    if (!fm) return true
    if (fm.inlineEditable !== undefined) return fm.inlineEditable
    return fm.kind === "text" || fm.kind === "richtext"
  }

  const fm = meta.fields[fieldPath]
  if (!fm) return true
  if (fm.inlineEditable !== undefined) return fm.inlineEditable
  return fm.kind === "text" || fm.kind === "richtext"
}

/** Resolve the ImageSpec for a block field, handling both scalar and list item paths. */
export function getImageSpec(blockType: string, fieldPath: string): ImageSpec | undefined {
  const meta = _blockMeta[blockType]
  if (!meta) return undefined

  // Handle list item paths like "cards[0].imageUrl" → listField "cards", itemField "imageUrl"
  const listMatch = fieldPath.match(/^([a-zA-Z_]+)\[\d+\]\.(.+)$/)
  if (listMatch) {
    const [, listKey, itemField] = listMatch
    return meta.listFields?.[listKey]?.itemFields[itemField]?.imageSpec
  }

  // Also support bare "listKey.itemField" (no index) as a convenience lookup
  const dotMatch = fieldPath.match(/^([a-zA-Z_]+)\.(.+)$/)
  if (dotMatch) {
    const [, listKey, itemField] = dotMatch
    const fromList = meta.listFields?.[listKey]?.itemFields[itemField]?.imageSpec
    if (fromList) return fromList
  }

  return meta.fields[fieldPath]?.imageSpec
}

// ---------------------------------------------------------------------------
// Backwards-compatible exports
// ---------------------------------------------------------------------------

/**
 * Block schemas keyed by type name.
 * Prefer `registerBlock()` for new blocks; this object is kept for backwards compat.
 */
export const blockSchemas: Record<string, z.ZodObject<any>> = _blockSchemas

export const allowedBlockTypes: string[] = []

export function getPropDisplayName(blockType: string | undefined, propKey: string) {
  if (!blockType) return propKey
  const meta = _blockMeta[blockType]
  if (!meta) return propKey
  // Check scalar fields
  const fm = meta.fields[propKey]
  if (fm?.label) return fm.label
  // Check list fields
  const lm = meta.listFields?.[propKey]
  if (lm?.label) return lm.label
  return propKey
}

function defaultScalarForField(field: FieldMeta, fieldKey: string): unknown {
  const label = field.label?.trim() || fieldKey
  if (field.kind === "text" || field.kind === "richtext" || field.kind === "imageAlt") return `New ${label}`
  if (field.kind === "url") return "/"
  if (field.kind === "image") return "/hero-generated.svg"
  if (field.kind === "color") return "#0f766e"
  if (field.kind === "number") return 0
  if (field.kind === "enum") return Array.isArray(field.options) && field.options.length > 0 ? field.options[0] : ""
  return `New ${label}`
}

export function defaultListItemForBlock(type: BlockType, listKey: string): Record<string, unknown> | null {
  const meta = _blockMeta[type]
  const listMeta = meta?.listFields?.[listKey]
  if (!listMeta) return null

  const item: Record<string, unknown> = {}
  for (const [fieldKey, fieldMeta] of Object.entries(listMeta.itemFields)) {
    item[fieldKey] = defaultScalarForField(fieldMeta, fieldKey)
  }
  return item
}

export const blockInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).refine((t) => t in _blockSchemas, { message: "Unknown block type" }),
  props: z.record(z.string(), z.unknown())
})

export function validateBlockProps(type: string, props: unknown) {
  const schema = _blockSchemas[type]
  if (!schema) return { success: false as const, error: new z.ZodError([{ code: "custom", message: `Unknown block type: ${type}`, path: [] }]) }
  return schema.safeParse(props)
}

// ---------------------------------------------------------------------------
// JSON Schema generation
// ---------------------------------------------------------------------------

/**
 * Recursively strip validation-only constraints from a JSON schema object.
 * The editor only needs structural info (types, properties, enums), not
 * validation rules like minLength, minimum, $schema, additionalProperties.
 */
function stripValidationConstraints(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripValidationConstraints)
  if (obj === null || typeof obj !== "object") return obj

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties" || key === "minLength" || key === "minimum" || key === "minItems" || key === "propertyNames" || key === "default") continue
    // Strip "required" only when it's the JSON Schema keyword (array of field names),
    // not when it's a property definition (e.g. ContactForm's "required" boolean field)
    if (key === "required" && Array.isArray(value)) continue
    result[key] = stripValidationConstraints(value)
  }
  return result
}

/**
 * Get a structural JSON schema for a registered block type.
 * Strips validation constraints (minLength, etc.) — the editor only needs
 * the shape to know which fields exist and their types.
 */
export function getBlockJsonSchema(type: string): Record<string, unknown> | undefined {
  const schema = _blockSchemas[type]
  if (!schema) return undefined
  const raw = z.toJSONSchema(schema) as Record<string, unknown>
  return stripValidationConstraints(raw) as Record<string, unknown>
}
