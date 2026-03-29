import { z } from "zod"
import { blockInstanceSchema, blockInstanceSchemaLenient, IMAGE_PLACEHOLDER, type BlockInstance } from "./blocks/_registry.ts"

// ---------------------------------------------------------------------------
// Site config
// ---------------------------------------------------------------------------

export const siteConfigSchema = z.object({
  name: z.string().optional(),
  logo: z.string().optional(),
  navLabels: z.record(z.string(), z.string()).optional(), // slug → custom label, e.g. { "/pricing": "Plans & Pricing" }
  navGroups: z.record(z.string(), z.array(z.string())).optional(), // parent label → child slugs, e.g. { "Products": ["/bananas", "/cherries"] }
  themeOverrides: z.record(z.string(), z.string()).optional(), // CSS variable overrides, e.g. { "--brand": "#2563eb" }
})
export type SiteConfig = z.infer<typeof siteConfigSchema>

// ---------------------------------------------------------------------------
// Page types & schemas
// ---------------------------------------------------------------------------

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

export const pageMetaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  ogImage: z.string().optional()
})

const pageDocFields = {
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().min(1),
  meta: pageMetaSchema.optional()
}

/** Lenient — accepts any block type (for ingesting content from sites with custom blocks). */
export const pageDocSchemaLenient: z.ZodType<PageDoc> = z.object({
  ...pageDocFields,
  blocks: z.array(blockInstanceSchemaLenient),
})

/** Strict — rejects block types not in the shared registry. */
export const pageDocSchema: z.ZodType<PageDoc> = z.object({
  ...pageDocFields,
  blocks: z.array(blockInstanceSchema),
})

// ---------------------------------------------------------------------------
// Operation schemas
// ---------------------------------------------------------------------------

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
  patch: z.record(z.string(), z.unknown())
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
  item: z.record(z.string(), z.unknown()),
  afterIndex: z.number().int().min(0).optional()
})
const updateItemSchema = z.object({
  op: z.literal("update_item"),
  pageSlug: z.string().min(1),
  blockId: z.string().min(1),
  listKey: z.string().min(1),
  index: z.number().int().min(0),
  patch: z.record(z.string(), z.unknown())
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
const updateSiteConfigSchema = z.object({
  op: z.literal("update_site_config"),
  patch: z.object({
    name: z.string().optional(),
    logo: z.string().optional(),
    navLabels: z.record(z.string(), z.string()).optional(),
    navGroups: z.record(z.string(), z.array(z.string())).optional(),
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
  updatePageMetaSchema,
  updateSiteConfigSchema
])

export type Operation = z.infer<typeof operationSchema>

export const editPlanSchema = z.object({
  intent: z.enum(["edit_plan", "needs_clarification", "content_answer"]),
  summary_for_user: z.string().min(1),
  change_log: z.array(z.string()),
  ops: z.array(operationSchema),
  suggested_next_actions: z.array(z.string()).max(5).optional()
})

export type EditPlan = z.infer<typeof editPlanSchema>

// ---------------------------------------------------------------------------
// site-editor/v2 patch transport messages
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

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
            imageUrl: IMAGE_PLACEHOLDER,
            imageAlt: "Abstract generated illustration for the hero section",
            imagePosition: "right"
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
            imageUrl: IMAGE_PLACEHOLDER,
            imageAlt: "Abstract generated illustration for the pricing hero",
            imagePosition: "right"
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
