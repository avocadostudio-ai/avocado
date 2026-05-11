import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { looksLikeUserInstruction } from "./chat-pipeline-ui.js"

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
}

function resolveImageFetchUrl(rawUrl: string): string | null {
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl
  if (rawUrl.startsWith("/")) {
    const origin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")
    return `${origin}${rawUrl}`
  }
  return null
}

async function fetchImageBytes(url: string): Promise<{ base64: string; mediaType: string } | null> {
  const resolved = resolveImageFetchUrl(url)
  if (!resolved) return null
  try {
    const res = await fetch(resolved)
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get("content-type")
    let mediaType = contentType?.split(";")[0]?.trim() ?? ""
    if (!mediaType || mediaType === "application/octet-stream") {
      const ext = resolved.match(/(\.[a-z]+)(?:\?|$)/i)?.[1]?.toLowerCase() ?? ""
      mediaType = MIME_BY_EXT[ext] ?? "image/jpeg"
    }
    return { base64: buffer.toString("base64"), mediaType }
  } catch {
    return null
  }
}

const ALT_PROMPT =
  "Write a 1-2 sentence noun-phrase description of this image suitable as accessibility alt text. " +
  "Be specific about the main subject, action, and setting. " +
  "Do not start with 'image of', 'photo of', or 'a/an '. " +
  "Do not mention 'AI-generated', watermarks, or metadata. " +
  "Reply with only the alt text — no quotes, no preamble, no labels."

export interface VisionAltLogger {
  warn?: (obj: object, msg: string) => void
}

/**
 * For inline "Generate alt text" / "Improve accessibility" / "Make more descriptive"
 * wand actions on imageAlt fields. Bypasses the heavy planner (which routinely returns
 * needs_clarification when the existing alt text looks like a user instruction or is
 * empty) and asks the vision model directly for one clean alt-text string.
 *
 * Provider preference order: anthropic → openai. Falls back to the other if the
 * preferred provider's API key is missing or the call fails. Returns null only
 * when both providers fail or no API key is set anywhere.
 */
export async function generateAltTextFromVision(opts: {
  imageUrl: string
  preferredProvider: "anthropic" | "openai" | "gemini"
  log?: VisionAltLogger
}): Promise<string | null> {
  const img = await fetchImageBytes(opts.imageUrl)
  if (!img) {
    opts.log?.warn?.({ imageUrl: opts.imageUrl }, "vision alt-text: failed to fetch image bytes")
    return null
  }

  const order: Array<"anthropic" | "openai"> =
    opts.preferredProvider === "openai" ? ["openai", "anthropic"] : ["anthropic", "openai"]

  for (const provider of order) {
    const text = await tryProvider(provider, img, opts.log)
    if (text) {
      const sanitized = sanitizeAltText(text)
      if (sanitized && !looksLikeUserInstruction(sanitized)) return sanitized
    }
  }
  return null
}

async function tryProvider(
  provider: "anthropic" | "openai",
  img: { base64: string; mediaType: string },
  log?: VisionAltLogger
): Promise<string | null> {
  try {
    if (provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) return null
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const model = process.env.ANTHROPIC_VISION_ALT_MODEL?.trim() || "claude-haiku-4-5-20251001"
      const result = await client.messages.create({
        model,
        max_tokens: 250,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: img.base64
                }
              },
              { type: "text", text: ALT_PROMPT }
            ]
          }
        ]
      })
      const textBlock = result.content.find((c) => c.type === "text")
      return textBlock && textBlock.type === "text" ? textBlock.text : null
    }

    if (!process.env.OPENAI_API_KEY) return null
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const model = process.env.OPENAI_VISION_ALT_MODEL?.trim() || process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o-mini"
    const dataUrl = `data:${img.mediaType};base64,${img.base64}`
    const completion = await client.chat.completions.create({
      model,
      max_tokens: 250,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ALT_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    })
    return completion.choices[0]?.message?.content ?? null
  } catch (err) {
    log?.warn?.(
      { provider, err: err instanceof Error ? err.message : String(err) },
      "vision alt-text direct call failed"
    )
    return null
  }
}

function sanitizeAltText(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .replace(/^(alt(\s+text)?\s*[:\-—]\s*)/i, "")
    .trim()
}

/**
 * Parse an editablePath into an op shape. Supports two cases:
 *   - "imageAlt"                   → update_props { imageAlt: alt }
 *   - "cards[0].imageAlt"          → update_item  cards index 0 { imageAlt: alt }
 *
 * Returns null when the path doesn't match either shape — callers should fall
 * back to the planner.
 */
export function parseAltPathForOp(path: string): { kind: "props"; key: string } | { kind: "item"; listKey: string; index: number; itemKey: string } | null {
  const nested = path.match(/^(\w+)\[(\d+)\]\.(\w+)$/)
  if (nested) {
    const [, listKey, indexStr, itemKey] = nested
    return { kind: "item", listKey, index: Number(indexStr), itemKey }
  }
  if (/^\w+$/.test(path)) return { kind: "props", key: path }
  return null
}
