import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createContentfulPublishHandler } from "../../../../lib/publish"
import { getContentfulPages } from "../../../../lib/contentful"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getContentfulPages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createContentfulPublishHandler({
    spaceId: process.env.CONTENTFUL_SPACE_ID!,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN!,
    environmentId: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  }),
})
