import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createSanityPublishHandler } from "../../../../lib/publish"
import { getSanityPages } from "../../../../lib/sanity.fetch"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getSanityPages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createSanityPublishHandler(),
})
