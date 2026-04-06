import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import type { PageDoc } from "@ai-site-editor/shared"

import "../../../../blocks/register"

const PAGES_PATH = resolve(process.cwd(), "content/pages.json")

async function loadPages(): Promise<PageDoc[]> {
  try {
    return JSON.parse(await readFile(PAGES_PATH, "utf-8")) as PageDoc[]
  } catch { return [] }
}

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: loadPages,
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createJsonFilePublishHandler(PAGES_PATH),
})
