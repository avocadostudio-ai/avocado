import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { errorResult } from "./_helpers.ts"

type ScreenshotResponse = {
  url: string
  slug: string
  mimeType: "image/jpeg"
  base64: string
  width: number
  height: number
}

export function registerPreviewTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-screenshot-page",
    "Take a full-page screenshot of a draft page and return it as an inline image. Use this to give chat-only hosts (Claude Desktop) a visual feedback channel after edits. The site must have a previewUrl registered (via avocado-register-site).",
    {
      slug: z.string().optional().describe("Page slug to screenshot, e.g. '/' or '/pricing'. Defaults to the home page."),
      previewUrl: z.string().url().optional().describe("Override the registered previewUrl (useful for ad-hoc captures)."),
    },
    async ({ slug, previewUrl }) => {
      try {
        const res = await client.request<ScreenshotResponse>("POST", "/preview/screenshot", {
          body: client.scopedBody({ slug, previewUrl }),
        })
        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot of ${res.url} (${res.width}×${res.height})`,
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
