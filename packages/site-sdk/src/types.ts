export type { PageDoc, PageMeta, BlockInstance } from "@avocadostudio-ai/shared"
export { pageDocSchema } from "@avocadostudio-ai/shared"

export type DraftContext = {
  session: string
  siteId: string
  editorOrigin: string
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>
