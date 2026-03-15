import { createBootstrapPagesHandler } from "@ai-site-editor/site-sdk"
import { getPublishedPage, getPublishedSlugs } from "../../../../lib/published-content-api"

export const { GET, OPTIONS } = createBootstrapPagesHandler(() => {
  return getPublishedSlugs()
    .map((slug) => getPublishedPage(slug))
    .filter((page): page is NonNullable<typeof page> => page !== null)
})
