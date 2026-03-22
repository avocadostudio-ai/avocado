import { writeFile } from "node:fs/promises"
import type { OnPublishFn } from "../editor-routes.ts"

/**
 * Publish handler that writes PageDoc[] to a local JSON file.
 *
 * Usage:
 * ```ts
 * import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
 *
 * createEditorApiHandler({
 *   getPages: () => [...],
 *   onPublish: createJsonFilePublishHandler("/path/to/published-content.json"),
 * })
 * ```
 */
export function createJsonFilePublishHandler(filePath: string): OnPublishFn {
  return async (pages, _config) => {
    const payload = JSON.stringify(pages, null, 2) + "\n"
    await writeFile(filePath, payload, "utf8")
    return { ok: true }
  }
}
