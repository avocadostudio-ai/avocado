import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { getPublishedPage, getPublishedSlugs } from "../../../../lib/published-content-api"
import { resolve } from "node:path"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () =>
    getPublishedSlugs()
      .map((slug) => getPublishedPage(slug))
      .filter((page): page is NonNullable<typeof page> => page !== null),
  onPublish: createJsonFilePublishHandler(
    resolve(process.cwd(), "lib/published-content.json"),
    { publicDir: resolve(process.cwd(), "public/generated-images") }
  ),
})
