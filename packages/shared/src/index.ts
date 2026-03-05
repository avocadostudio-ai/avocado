import { z } from "zod"
export { getConfiguredDraftSecret, getSafeInternalRedirectPath, validateDraftSecret, type DraftSecretValidationResult } from "./draft-mode.ts"
export {
  editorComponentSchema,
  editorComponentsManifestSchema,
  jsonSchemaLikeSchema,
  validateByJsonSchemaLike,
  validateManifestDefaultProps,
  type EditorComponentDefinition,
  type EditorComponentsManifest
} from "./editor-components-manifest.ts"

export type PageMeta = {
  title?: string
  description?: string
  ogImage?: string
}

export type PageDoc = {
  id: string
  slug: string
  title: string
  updatedAt: string
  blocks: BlockInstance[]
  meta?: PageMeta
}

export type BlockInstance = {
  id: string
  type: BlockType
  props: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Field & block metadata types
// ---------------------------------------------------------------------------

/** Semantic kind for a block prop field. */
export type FieldKind = "text" | "richtext" | "url" | "image" | "imageAlt" | "enum" | "color" | "number"

/** Metadata for a single prop field on a block. */
export type FieldMeta = {
  kind: FieldKind
  /** Human-readable label (e.g. "Heading text"). Falls back to prop key. */
  label?: string
  /** Whether this field supports inline editing in the preview. Defaults based on kind. */
  inlineEditable?: boolean
  /** For enum kind: the allowed values. */
  options?: string[]
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

// ---------------------------------------------------------------------------
// Built-in block registrations
// ---------------------------------------------------------------------------

const f = {
  text: (label?: string): FieldMeta => ({ kind: "text", label }),
  richtext: (label?: string): FieldMeta => ({ kind: "richtext", label }),
  url: (label?: string): FieldMeta => ({ kind: "url", label, inlineEditable: false }),
  image: (label?: string): FieldMeta => ({ kind: "image", label, inlineEditable: false }),
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
      imageUrl: f.image("Hero image"),
      imageAlt: f.imageAlt("Hero image alt text"),
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
      imageUrl: f.image("Card image"),
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
          imageUrl: f.image("Card image"),
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

registerBlock("TwoColumn", {
  schema: z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
    imageUrl: z.string().min(1),
    imageAlt: z.string().min(1),
    imagePosition: z.enum(["left", "right"]).default("right"),
    ctaText: z.string().optional(),
    ctaHref: z.string().optional()
  }),
  meta: {
    displayName: "Two Column",
    description: "Image + text side-by-side layout with configurable image position.",
    category: "layout",
    fields: {
      heading: f.text("Heading"),
      body: f.richtext("Body text"),
      imageUrl: f.image("Image"),
      imageAlt: f.imageAlt("Image alt text"),
      imagePosition: { kind: "enum", label: "Image position", options: ["left", "right"], inlineEditable: false },
      ctaText: f.text("CTA button text"),
      ctaHref: f.url("CTA link"),
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
  [K in "Hero" | "FeatureGrid" | "Testimonials" | "FAQAccordion" | "CTA" | "Card" | "CardGrid" | "RichText" | "Stats" | "TwoColumn" | "Footer"]: z.ZodObject<any>
}

export type BlockType = string & {}
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
      imageAlt: "Abstract generated illustration"
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
      heading: "Built for teams",
      body: "Ship changes quickly with a clear, reliable workflow.",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Team collaborating on a website update",
      imagePosition: "right",
      ctaText: "Learn more",
      ctaHref: "/"
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
  props: z.record(z.unknown())
})

export const pageMetaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  ogImage: z.string().optional()
})

export const pageDocSchema: z.ZodType<PageDoc> = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().min(1),
  blocks: z.array(blockInstanceSchema),
  meta: pageMetaSchema.optional()
})

const createPageSchema = z.object({
  op: z.literal("create_page"),
  page: pageDocSchema
})
const addBlockSchema = z.object({
  op: z.literal("add_block"),
  pageSlug: z.string().min(1),
  afterBlockId: z.string().min(1).optional(),
  block: blockInstanceSchema
})
const updatePropsSchema = z.object({
  op: z.literal("update_props"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  patch: z.record(z.unknown())
})
const removeBlockSchema = z.object({
  op: z.literal("remove_block"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1)
})
const moveBlockSchema = z.object({
  op: z.literal("move_block"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  afterBlockId: z.string().min(1).optional()
})
const duplicateBlockSchema = z.object({
  op: z.literal("duplicate_block"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  toPageSlug: z.string().min(1).optional(),
  newBlockId: z.string().min(1).optional(),
  afterBlockId: z.string().min(1).optional()
})
const addItemSchema = z.object({
  op: z.literal("add_item"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  listKey: z.string().min(1),
  item: z.record(z.unknown()),
  afterIndex: z.number().int().min(0).optional()
})
const updateItemSchema = z.object({
  op: z.literal("update_item"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  listKey: z.string().min(1),
  index: z.number().int().min(0),
  patch: z.record(z.unknown())
})
const removeItemSchema = z.object({
  op: z.literal("remove_item"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  listKey: z.string().min(1),
  index: z.number().int().min(0)
})
const moveItemSchema = z.object({
  op: z.literal("move_item"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  listKey: z.string().min(1),
  index: z.number().int().min(0),
  afterIndex: z.number().int().min(0).optional()
})
const renamePageSchema = z.object({
  op: z.literal("rename_page"),
  pageSlug: z.string().min(1),
  newPageSlug: z.string().min(1),
  newTitle: z.string().min(1).optional()
})
const removePageSchema = z.object({
  op: z.literal("remove_page"),
  pageSlug: z.string().min(1)
})
const movePageSchema = z.object({
  op: z.literal("move_page"),
  pageSlug: z.string().min(1),
  afterPageSlug: z.string().min(1).optional()
})
const duplicatePageSchema = z.object({
  op: z.literal("duplicate_page"),
  pageSlug: z.string().min(1),
  newPageSlug: z.string().min(1).optional(),
  newTitle: z.string().min(1).optional(),
  afterPageSlug: z.string().min(1).optional()
})
const updatePageMetaSchema = z.object({
  op: z.literal("update_page_meta"),
  pageSlug: z.string().min(1),
  patch: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    ogImage: z.string().optional()
  })
})

export const operationSchema = z.discriminatedUnion("op", [
  createPageSchema,
  addBlockSchema,
  updatePropsSchema,
  removeBlockSchema,
  moveBlockSchema,
  duplicateBlockSchema,
  addItemSchema,
  updateItemSchema,
  removeItemSchema,
  moveItemSchema,
  renamePageSchema,
  removePageSchema,
  movePageSchema,
  duplicatePageSchema,
  updatePageMetaSchema
])

export type Operation = z.infer<typeof operationSchema>

export const editPlanSchema = z.object({
  intent: z.enum(["edit_plan", "needs_clarification"]),
  summary_for_user: z.string().min(1),
  change_log: z.array(z.string()),
  ops: z.array(operationSchema),
  suggested_next_actions: z.array(z.string()).max(5).optional()
})

export type EditPlan = z.infer<typeof editPlanSchema>

// site-editor/v2 patch transport messages
export type PatchRejectReason = "version_mismatch" | "apply_error" | "unknown_op"

export type ApplyPatchMessage = {
  type: "applyPatch"
  txId: string
  op: Operation           // single op to apply optimistically
  fromVersion: number     // expected current version in iframe
  toVersion: number       // version after this op
  focusBlockId?: string
}

export type PatchAckMessage = {
  type: "patchAck"
  txId: string
  accepted: boolean
  reason?: PatchRejectReason
}

export type ResetToServerMessage = {
  type: "resetToServer"
  toVersion: number
  focusBlockId?: string
}

export function validateBlockProps(type: string, props: unknown) {
  const schema = _blockSchemas[type]
  if (!schema) return { success: false as const, error: new z.ZodError([{ code: "custom", message: `Unknown block type: ${type}`, path: [] }]) }
  return schema.safeParse(props)
}

export function demoPublishedPages(): PageDoc[] {
  const now = new Date().toISOString()
  return [
    {
      id: "p_home",
      slug: "/",
      title: "Home",
      updatedAt: now,
      blocks: [
        {
          id: "b_hero_home",
          type: "Hero",
          props: {
            heading: "Build websites with plain language",
            subheading: "Edit content instantly with chat and live preview.",
            ctaText: "Start Editing",
            ctaHref: "/pricing",
            imageUrl: "/hero-generated.svg",
            imageAlt: "Abstract generated illustration for the hero section"
          }
        },
        {
          id: "b_features_home",
          type: "FeatureGrid",
          props: {
            title: "Why teams use it",
            features: [
              { title: "Fast edits", description: "See updates without rebuilding." },
              { title: "Safe changes", description: "Schema-validated structured operations." },
              { title: "Simple workflow", description: "Chat to edit, preview to verify." }
            ]
          }
        },
        {
          id: "b_cta_home",
          type: "CTA",
          props: {
            title: "Ready for your first change?",
            description: "Use the editor to modify this page now.",
            ctaText: "Open Pricing",
            ctaHref: "/pricing"
          }
        }
      ]
    },
    {
      id: "p_pricing",
      slug: "/pricing",
      title: "Pricing",
      updatedAt: now,
      blocks: [
        {
          id: "b_hero_pricing",
          type: "Hero",
          props: {
            heading: "Pricing that grows with you",
            subheading: "Start free, upgrade when you're ready.",
            ctaText: "Choose Plan",
            ctaHref: "/",
            imageUrl: "/hero-generated.svg",
            imageAlt: "Abstract generated illustration for the pricing hero"
          }
        },
        {
          id: "b_faq_pricing",
          type: "FAQAccordion",
          props: {
            title: "Pricing FAQ",
            items: [
              { q: "Can I cancel anytime?", a: "Yes, there are no long-term contracts." },
              { q: "Do you offer support?", a: "Yes, email support is included." }
            ]
          }
        }
      ]
    }
  ]
}
