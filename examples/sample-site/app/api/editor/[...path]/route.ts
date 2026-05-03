import { resolve } from "node:path"
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { getSamplePages } from "../../../../lib/pages"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getSamplePages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createJsonFilePublishHandler(
    resolve(process.cwd(), "content/pages.json"),
    { publicDir: resolve(process.cwd(), "public/generated-images") }
  ),
})
