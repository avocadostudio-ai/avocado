import { writeFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import type { OnPublishFn } from "../editor-routes.ts"

/**
 * Publish handler that writes PageDoc[] to a local JSON file.
 *
 * When `publicDir` is provided, inline assets (base64 images from the
 * orchestrator) are written to disk and their localhost URLs are rewritten
 * to relative paths in the JSON output.
 *
 * Usage:
 * ```ts
 * import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"
 *
 * createEditorApiHandler({
 *   getPages: () => [...],
 *   onPublish: createJsonFilePublishHandler("/path/to/published-content.json", {
 *     publicDir: "/path/to/public/generated-images",
 *   }),
 * })
 * ```
 */
export function createJsonFilePublishHandler(
  filePath: string,
  options?: { publicDir?: string; imagePathPrefix?: string }
): OnPublishFn {
  return async (pages, _config, context) => {
    let output = pages

    if (options?.publicDir && context?.assets && Object.keys(context.assets).length > 0) {
      const prefix = options.imagePathPrefix ?? "/generated-images/"
      await mkdir(options.publicDir, { recursive: true })

      let json = JSON.stringify(pages, null, 2)
      for (const [originalUrl, asset] of Object.entries(context.assets)) {
        const dest = resolve(options.publicDir, asset.fileName)
        await writeFile(dest, Buffer.from(asset.data, "base64"))
        json = json.replaceAll(originalUrl, `${prefix}${asset.fileName}`)
      }
      output = JSON.parse(json)
    }

    const payload = JSON.stringify(output, null, 2) + "\n"
    await writeFile(filePath, payload, "utf8")
    return { ok: true }
  }
}
