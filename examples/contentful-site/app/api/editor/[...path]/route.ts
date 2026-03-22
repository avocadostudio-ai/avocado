import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createContentfulPublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/contentful"
import { getContentfulPages } from "../../../../lib/contentful"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getContentfulPages(),
  onPublish: createContentfulPublishHandler({
    spaceId: process.env.CONTENTFUL_SPACE_ID!,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN!,
    environmentId: process.env.CONTENTFUL_ENVIRONMENT ?? "master",
  }),
})
