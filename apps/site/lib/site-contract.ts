import { z } from "zod"

export type BlockInstance = {
  id: string
  type: string
  props: Record<string, unknown>
}

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

export const blockInstanceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
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
