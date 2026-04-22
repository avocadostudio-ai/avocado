import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { errorResult } from "./_helpers.ts"

type ScreenshotResponse = {
  url: string
  slug: string
  mode: "draft" | "published"
  mimeType: "image/jpeg"
  base64: string
  width: number
  height: number
}

export function registerPreviewTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-screenshot-page",
    "Take a full-page screenshot of a page and return it as an inline image. Defaults to the draft (what the editor sees), so in-progress edits are visible before publish. Pass `published: true` to screenshot the live public route instead. Site must have a previewUrl registered (via avocado-register-site).",
    {
      slug: z.string().optional().describe("Page slug to screenshot, e.g. '/' or '/pricing'. Defaults to the home page."),
      published: z.boolean().optional().describe("If true, screenshot the published public route instead of the draft. Defaults to false (draft)."),
      previewUrl: z.string().url().optional().describe("Override the registered previewUrl (useful for ad-hoc captures)."),
    },
    async ({ slug, published, previewUrl }) => {
      try {
        const res = await client.request<ScreenshotResponse>("POST", "/preview/screenshot", {
          body: client.scopedBody({ slug, published, previewUrl }),
        })
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of ${res.url} (${res.mode} mode, ${res.width}×${res.height})`,
            },
            {
              type: "image" as const,
              data: res.base64,
              mimeType: res.mimeType,
            },
          ],
        }
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
