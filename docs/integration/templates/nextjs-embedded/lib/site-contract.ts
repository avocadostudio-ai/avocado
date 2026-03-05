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
