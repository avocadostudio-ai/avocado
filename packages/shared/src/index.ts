import { z } from "zod"

export type PageDoc = {
  id: string
  slug: string
  title: string
  updatedAt: string
  blocks: BlockInstance[]
}

export type BlockInstance = {
  id: string
  type: BlockType
  props: Record<string, unknown>
}

export const blockSchemas = {
  Hero: z.object({
    heading: z.string().min(1),
    subheading: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1)
  }),
  FeatureGrid: z.object({
    title: z.string().min(1),
    features: z.array(z.object({ title: z.string().min(1), description: z.string().min(1) })).min(1)
  }),
  Testimonials: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ quote: z.string().min(1), author: z.string().min(1) })).min(1)
  }),
  FAQAccordion: z.object({
    title: z.string().min(1),
    items: z.array(z.object({ q: z.string().min(1), a: z.string().min(1) })).min(1)
  }),
  CTA: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    ctaText: z.string().min(1),
    ctaHref: z.string().min(1)
  })
} as const

export type BlockType = keyof typeof blockSchemas
export const allowedBlockTypes = Object.keys(blockSchemas) as BlockType[]

export const blockInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.enum(allowedBlockTypes as [BlockType, ...BlockType[]]),
  props: z.record(z.unknown())
})

export const pageDocSchema: z.ZodType<PageDoc> = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  updatedAt: z.string().min(1),
  blocks: z.array(blockInstanceSchema)
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

export const operationSchema = z.discriminatedUnion("op", [
  createPageSchema,
  addBlockSchema,
  updatePropsSchema,
  removeBlockSchema,
  moveBlockSchema
])

export type Operation = z.infer<typeof operationSchema>

export const editPlanSchema = z.object({
  intent: z.enum(["edit_plan", "needs_clarification"]),
  summary_for_user: z.string().min(1),
  change_log: z.array(z.string()),
  ops: z.array(operationSchema)
})

export type EditPlan = z.infer<typeof editPlanSchema>

export function validateBlockProps(type: BlockType, props: unknown) {
  return blockSchemas[type].safeParse(props)
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
            ctaHref: "/pricing"
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
            ctaHref: "/"
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
