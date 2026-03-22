import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createStrapiPublishHandler } from "../../../../lib/publish"
import { getStrapiPages } from "../../../../lib/strapi.fetch"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getStrapiPages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createStrapiPublishHandler(),
})
