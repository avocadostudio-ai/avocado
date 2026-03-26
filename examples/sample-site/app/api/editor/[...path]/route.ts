import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import type { PageDoc } from "@ai-site-editor/shared"
import pagesData from "../../../../content/pages.json"
import { resolve } from "node:path"

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

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => Object.entries(pages).map(([slug, raw]) => toPageDoc(slug, raw)),
  onPublish: createJsonFilePublishHandler(
    resolve(process.cwd(), "content/pages.json"),
    { publicDir: resolve(process.cwd(), "public/generated-images") }
  ),
})
