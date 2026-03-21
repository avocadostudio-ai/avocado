import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { getPublishedPage, getPublishedSlugs } from "../../../../lib/published-content-api"

export const { GET, OPTIONS } = createEditorApiHandler({
  getPages: () =>
    getPublishedSlugs()
      .map((slug) => getPublishedPage(slug))
      .filter((page): page is NonNullable<typeof page> => page !== null),
})
