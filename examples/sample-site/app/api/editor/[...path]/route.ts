import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import type { PageDoc } from "@ai-site-editor/shared"
import pagesData from "../../../../content/pages.json"

type RawPage = { title: string; blocks: { id: string; type: string; props: Record<string, unknown> }[] }
const pages: Record<string, RawPage> = pagesData

function toPageDoc(slug: string, raw: RawPage): PageDoc {
  return {
    id: slug,
    slug,
    title: raw.title,
    updatedAt: new Date().toISOString(),
    blocks: raw.blocks.map((b) => ({ id: b.id, type: b.type, props: b.props })),
  }
}

export const { GET, OPTIONS } = createEditorApiHandler({
  getPages: () => Object.entries(pages).map(([slug, raw]) => toPageDoc(slug, raw)),
})
