import { z } from "zod"

// ---------------------------------------------------------------------------
// Field & block metadata types
// ---------------------------------------------------------------------------

/** Semantic kind for a block prop field. */
export type FieldKind = "text" | "richtext" | "url" | "image" | "imageAlt" | "enum" | "color" | "number"

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
  _blockMeta[type] = config.meta
}

/** Get metadata for a registered block type, or undefined. */
export function getBlockMeta(type: string): BlockMeta | undefined {
  return _blockMeta[type]
}

/** Get all registered block metadata. */
export function getAllBlockMeta(): Readonly<Record<string, BlockMeta>> {
  return _blockMeta
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
// Built-in block registrations
// ---------------------------------------------------------------------------

const f = {
  text: (label?: string): FieldMeta => ({ kind: "text", label }),
  richtext: (label?: string): FieldMeta => ({ kind: "richtext", label }),
  url: (label?: string): FieldMeta => ({ kind: "url", label, inlineEditable: false }),
  image: (label?: string, imageSpec?: ImageSpec): FieldMeta => ({ kind: "image", label, inlineEditable: false, ...(imageSpec ? { imageSpec } : {}) }),
  imageAlt: (label?: string): FieldMeta => ({ kind: "imageAlt", label }),
} as const

registerBlock("Hero", {
  schema: z.object({
    heading: z.string().min(1),
    subheading: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    imagePosition: z.enum(["left", "right"]).default("right"),
    secondaryCtaText: z.string().optional(),
    secondaryCtaHref: z.string().optional()
  }),
  meta: {
    displayName: "Hero",
    description: "Full-width hero section with headline, subheading, CTA buttons, and image.",
    category: "content",
    fields: {
      heading: f.text("Heading"),
      subheading: f.text("Subheading"),
      ctaText: f.text("CTA button text"),
      ctaHref: f.url("CTA link"),
      imageUrl: f.image("Hero image", { aspectRatio: "landscape", width: 1536, height: 1024 }),
      imageAlt: f.imageAlt("Hero image alt text"),
      imagePosition: { kind: "enum", label: "Image position", options: ["left", "right"], inlineEditable: false },
      secondaryCtaText: f.text("Secondary CTA text"),
      secondaryCtaHref: f.url("Secondary CTA link"),
    }
  }
})

registerBlock("FeatureGrid", {
  schema: z.object({
    title: z.string().min(1),
    features: z.array(z.object({ title: z.string().min(1), description: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Feature Grid",
    description: "Grid of feature cards with title and description.",
    category: "content",
    fields: { title: f.text("Section title") },
    listFields: {
      features: {
        label: "Features",
        itemFields: { title: f.text("Feature title"), description: f.text("Feature description") }
      }
    }
  }
})

registerBlock("Testimonials", {
  schema: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ quote: z.string().min(1), author: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Testimonials",
    description: "Grid of testimonial cards with quotes and authors.",
    category: "content",
    fields: { title: f.text("Section title") },
    listFields: {
      items: {
        label: "Testimonials",
        itemFields: { quote: f.text("Quote"), author: f.text("Author") }
      }
    }
  }
})

registerBlock("FAQAccordion", {
  schema: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "FAQ Accordion",
    description: "Expandable question-and-answer section.",
    category: "content",
    fields: { title: f.text("Section title") },
    listFields: {
      items: {
        label: "FAQ items",
        itemFields: { q: f.text("Question"), a: f.text("Answer") }
      }
    }
  }
})

registerBlock("CTA", {
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1)
  }),
  meta: {
    displayName: "Call to Action",
    description: "Centered promotional section with a button.",
    category: "conversion",
    fields: {
      title: f.text("Headline"),
      description: f.text("Description"),
      ctaText: f.text("Button text"),
      ctaHref: f.url("Button link"),
    }
  }
})

registerBlock("Card", {
  schema: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1),
    imageUrl: z.string().min(1).optional(),
    imageAlt: z.string().min(1).optional()
  }),
  meta: {
    displayName: "Card",
    description: "Single prominent card with a CTA.",
    category: "content",
    fields: {
      title: f.text("Card title"),
      description: f.text("Card description"),
      ctaText: f.text("Button text"),
      ctaHref: f.url("Button link"),
      imageUrl: f.image("Card image", { aspectRatio: "landscape", width: 768, height: 512 }),
      imageAlt: f.imageAlt("Card image alt text"),
    }
  }
})

registerBlock("CardGrid", {
  schema: z.object({
    title: z.string().min(1),
    cards: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().min(1),
          ctaText: z.string().min(1),
          ctaHref: z.string().min(1),
          imageUrl: z.string().min(1).optional(),
          imageAlt: z.string().min(1).optional()
        })
      )
      .min(1)
  }),
  meta: {
    displayName: "Card Grid",
    description: "Grid of cards, each with title, description, and CTA.",
    category: "content",
    fields: { title: f.text("Section title") },
    listFields: {
      cards: {
        label: "Cards",
        itemFields: {
          title: f.text("Card title"),
          description: f.text("Card description"),
          ctaText: f.text("Button text"),
          ctaHref: f.url("Button link"),
          imageUrl: f.image("Card image", { aspectRatio: "landscape", width: 768, height: 512 }),
          imageAlt: f.imageAlt("Card image alt text"),
        }
      }
    }
  }
})

registerBlock("RichText", {
  schema: z.object({
    title: z.string(),
    body: z.string().min(1)
  }),
  meta: {
    displayName: "Rich Text",
    description: "Freeform text content with markdown-style formatting.",
    category: "content",
    fields: {
      title: f.text("Section title"),
      body: f.richtext("Body"),
    }
  }
})

registerBlock("Stats", {
  schema: z.object({
    title: z.string().optional(),
    stats: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Stats",
    description: "Row of big numbers with labels (e.g. 10K+ Users).",
    category: "content",
    fields: { title: f.text("Section title") },
    listFields: {
      stats: {
        label: "Stats",
        itemFields: { value: f.text("Value"), label: f.text("Label") }
      }
    }
  }
})

const contactFormField = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "email", "date", "number", "textarea"]).default("text"),
  placeholder: z.string().optional(),
  required: z.boolean().optional()
})

registerBlock("ContactForm", {
  schema: z.object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    submitLabel: z.string().min(1),
    fields: z.array(contactFormField).min(1)
  }),
  meta: {
    displayName: "Contact Form",
    description: "Contact or booking inquiry form with configurable fields.",
    category: "conversion",
    fields: {
      title: f.text("Heading"),
      subtitle: f.text("Subtitle"),
      submitLabel: f.text("Submit button text"),
    },
    listFields: {
      fields: {
        label: "Form fields",
        itemFields: {
          label: f.text("Field label"),
          placeholder: f.text("Placeholder"),
        }
      }
    }
  }
})

const twoColumnChild = z.object({
  type: z.enum(["heading", "paragraph", "cta", "image", "video"]),
  text: z.string().optional(),
  label: z.string().optional(),
  href: z.string().optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  poster: z.string().optional()
})

registerBlock("TwoColumn", {
  schema: z.object({
    variant: z.enum(["default", "accent"]).default("default"),
    left: z.array(twoColumnChild).min(1),
    right: z.array(twoColumnChild).min(1)
  }),
  meta: {
    displayName: "Two Column",
    description: "Composite two-column layout with typed child components in each column.",
    category: "layout",
    fields: {
      variant: { kind: "enum", label: "Style variant", options: ["default", "accent"], inlineEditable: false },
    },
    listFields: {
      left: {
        label: "Left column items",
        itemFields: {
          type: { kind: "enum", label: "Component type", options: ["heading", "paragraph", "cta", "image", "video"] },
          text: f.text("Text content"),
          label: f.text("Button label"),
          href: f.url("Link URL"),
          src: f.image("Media source", { aspectRatio: "portrait", width: 768, height: 1024 }),
          alt: f.imageAlt("Alt text"),
          poster: f.image("Video poster image", { aspectRatio: "landscape", width: 768, height: 512 }),
        }
      },
      right: {
        label: "Right column items",
        itemFields: {
          type: { kind: "enum", label: "Component type", options: ["heading", "paragraph", "cta", "image", "video"] },
          text: f.text("Text content"),
          label: f.text("Button label"),
          href: f.url("Link URL"),
          src: f.image("Media source", { aspectRatio: "portrait", width: 768, height: 1024 }),
          alt: f.imageAlt("Alt text"),
          poster: f.image("Video poster image", { aspectRatio: "landscape", width: 768, height: 512 }),
        }
      }
    }
  }
})

registerBlock("Footer", {
  schema: z.object({
    copyright: z.string().min(1),
    columns: z.array(z.object({ title: z.string().min(1), links: z.string().min(1) })).min(1)
  }),
  meta: {
    displayName: "Footer",
    description: "Multi-column footer with link groups and copyright.",
    category: "navigation",
    fields: { copyright: f.text("Copyright text") },
    listFields: {
      columns: {
        label: "Footer columns",
        itemFields: { title: f.text("Column title"), links: f.richtext("Links (one label|url per line)") }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Backwards-compatible exports
// ---------------------------------------------------------------------------

/**
 * Block schemas keyed by type name.
 * Prefer `registerBlock()` for new blocks; this object is kept for backwards compat.
 */
export const blockSchemas = _blockSchemas as Record<string, z.ZodObject<any>> & {
  [K in "Hero" | "FeatureGrid" | "Testimonials" | "FAQAccordion" | "CTA" | "Card" | "CardGrid" | "RichText" | "Stats" | "ContactForm" | "TwoColumn" | "Footer"]: z.ZodObject<any>
}

export const allowedBlockTypes: string[] = Object.keys(_blockSchemas)

// Keep allowedBlockTypes in sync when new blocks are registered after module load
const _origRegister = registerBlock
export { _origRegister as _registerBlockInternal }

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

export function defaultPropsForType(type: BlockType): Record<string, unknown> {
  if (type === "Hero") {
    return {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Abstract generated illustration",
      imagePosition: "right"
    }
  }
  if (type === "FeatureGrid") {
    return {
      title: "Key features",
      features: [
        { title: "Fast setup", description: "Launch quickly with guided defaults." },
        { title: "Safe edits", description: "Structured operations keep content valid." },
        { title: "Live updates", description: "Preview changes immediately." }
      ]
    }
  }
  if (type === "Testimonials") {
    return {
      title: "What customers say",
      items: [
        { quote: "We launched faster than expected.", author: "Alex" },
        { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
      ]
    }
  }
  if (type === "FAQAccordion") {
    return {
      title: "Frequently asked questions",
      items: [
        { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
        { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
      ]
    }
  }
  if (type === "Card") {
    return {
      title: "Launch faster",
      description: "Go from idea to published changes in minutes.",
      ctaText: "Learn more",
      ctaHref: "/pricing"
    }
  }
  if (type === "RichText") {
    return {
      title: "",
      body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
    }
  }
  if (type === "CardGrid") {
    return {
      title: "Explore more",
      cards: [
        {
          title: "Fast setup",
          description: "Create and ship updates quickly.",
          ctaText: "Get started",
          ctaHref: "/"
        },
        {
          title: "Safe updates",
          description: "Schema-validated edits reduce breakage.",
          ctaText: "See how",
          ctaHref: "/pricing"
        },
        {
          title: "Team workflow",
          description: "Collaborate with clear, reviewable changes.",
          ctaText: "Read guide",
          ctaHref: "/"
        }
      ]
    }
  }
  if (type === "Stats") {
    return {
      title: "By the numbers",
      stats: [
        { value: "10k+", label: "Active users" },
        { value: "99.9%", label: "Uptime" },
        { value: "24/7", label: "Support" }
      ]
    }
  }
  if (type === "TwoColumn") {
    return {
      variant: "default",
      left: [
        { type: "heading", text: "Built for teams" },
        { type: "paragraph", text: "Ship changes quickly with a clear, reliable workflow." },
        { type: "cta", label: "Learn more", href: "/" }
      ],
      right: [
        { type: "image", src: "/hero-generated.svg", alt: "Team collaborating on a website update" }
      ]
    }
  }
  if (type === "Footer") {
    return {
      copyright: "© 2026 Your Company",
      columns: [
        { title: "Product", links: "Features|/features\nPricing|/pricing" },
        { title: "Company", links: "About|/about\nContact|/contact" }
      ]
    }
  }
  if (type === "CTA") {
    return {
      title: "Ready to get started?",
      description: "Apply your next change in seconds.",
      ctaText: "Start now",
      ctaHref: "/"
    }
  }
  return {
    title: "Ready to get started?",
    description: "Apply your next change in seconds.",
    ctaText: "Start now",
    ctaHref: "/"
  }
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
