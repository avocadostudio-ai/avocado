export type CmsChoice = "sanity" | "contentful" | "strapi" | "none"
export type BlocksMode = "default" | "custom"

export type ScaffoldConfig = {
  cms: CmsChoice
  siteId: string
  blocksMode: BlocksMode
}

export type GeneratedFile = {
  path: string
  content: string
}
