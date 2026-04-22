import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { OrchestratorClient } from "../orchestrator-client.ts"
import { jsonResult, errorResult } from "./_helpers.ts"

/**
 * Helper: orchestrator endpoints for upload/transcribe/interpret accept multipart only.
 * MCP tool args are JSON, so we accept base64Data + mimeType and build a FormData in-process.
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
  // Strip optional data URL prefix.
  const data = base64.replace(/^data:[^;]+;base64,/, "")
  const bytes = Buffer.from(data, "base64")
  return new Blob([bytes], { type: mimeType })
}

export function registerMediaTools(server: McpServer, client: OrchestratorClient) {
  server.tool(
    "avocado-upload-image",
    "Upload an image to the orchestrator. Returns a URL usable as a block prop (Hero imageUrl, Card image, etc.). Accepts base64-encoded bytes + mime type.",
    {
      base64Data: z.string().min(1).describe("Base64-encoded image bytes. Data URL prefix (data:image/...;base64,) is tolerated."),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      filename: z.string().optional().describe("Optional filename hint; defaults to 'upload.<ext>'."),
    },
    async ({ base64Data, mimeType, filename }) => {
      try {
        const form = new FormData()
        const ext = mimeType.split("/")[1]
        form.append("image", base64ToBlob(base64Data, mimeType), filename ?? `upload.${ext}`)
        return jsonResult(await client.request("POST", "/image/upload", { formData: form }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-generate-image",
    "Generate an image from a text prompt using the configured provider (OpenAI or Gemini). Returns a URL + alt text.",
    {
      prompt: z.string().min(1).describe("Description of the image to generate."),
      aspectRatio: z.enum(["landscape", "square", "portrait"]).optional(),
      provider: z.enum(["openai", "gemini"]).optional().describe("Override the default image provider."),
      model: z.string().optional().describe("Override the default model name."),
    },
    async (args) => {
      try {
        return jsonResult(await client.request("POST", "/image/generate", { body: args }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-search-unsplash",
    "Search Unsplash for stock photos matching a query. Returns an array of { imageUrl, thumbUrl, alt, author }.",
    {
      q: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
      page: z.number().int().min(1).optional(),
    },
    async (args) => {
      try {
        return jsonResult(await client.request("GET", "/unsplash/search", { query: args }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-transcribe-audio",
    "Transcribe an audio clip to text via OpenAI Whisper. Accepts base64-encoded audio bytes.",
    {
      base64Data: z.string().min(1),
      mimeType: z.enum(["audio/mp3", "audio/mpeg", "audio/mp4", "audio/mpga", "audio/m4a", "audio/wav", "audio/webm"]),
      filename: z.string().optional(),
    },
    async ({ base64Data, mimeType, filename }) => {
      try {
        const form = new FormData()
        const ext = mimeType.split("/")[1]
        form.append("audio", base64ToBlob(base64Data, mimeType), filename ?? `clip.${ext}`)
        return jsonResult(await client.request("POST", "/audio/transcribe", { formData: form }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )

  server.tool(
    "avocado-interpret-image",
    "Run vision analysis on an image and return a one-sentence description (useful for alt text or screenshot-to-intent).",
    {
      base64Data: z.string().min(1),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      filename: z.string().optional(),
    },
    async ({ base64Data, mimeType, filename }) => {
      try {
        const form = new FormData()
        const ext = mimeType.split("/")[1]
        form.append("image", base64ToBlob(base64Data, mimeType), filename ?? `image.${ext}`)
        return jsonResult(await client.request("POST", "/image/interpret", { formData: form }))
      } catch (err) {
        return errorResult(err)
      }
    }
  )
}
