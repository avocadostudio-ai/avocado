export type { PageDoc, PageMeta, BlockInstance } from "@ai-site-editor/shared"
export { pageDocSchema } from "@ai-site-editor/shared"

export type DraftContext = {
  session: string
  siteId: string
  editorOrigin: string
}

export type SearchParamsRecord = Record<string, string | string[] | undefined>
