import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { getContentfulPages } from "@/lib/contentful"
import { createMarketingPublishHandler } from "@/lib/publish"

// Custom blocks must be registered before the editor API handler runs.
import "@/src/blocks/register"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getContentfulPages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createMarketingPublishHandler({
    spaceId: process.env.CONTENTFUL_SPACE_ID!,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN!,
    environmentId: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  }),
})
