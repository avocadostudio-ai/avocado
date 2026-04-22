import type { OrchestratorClient } from "../orchestrator-client.ts"

export function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  }
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  }
}

type ChatResult = {
  status?: string
  undoSlug?: string
  mentionedSlugs?: string[]
}

type ScreenshotResponse = {
  url: string
  slug: string
  mode: "draft" | "published"
  mimeType: "image/jpeg"
  base64: string
  width: number
  height: number
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

/**
 * Build a tool result for a /chat response, optionally chaining a draft-preview
 * screenshot of the page that was just mutated. We only screenshot when the
 * chat returned `applied` — pending/clarification states haven't changed state
 * so there's nothing new to show. Screenshot failures are non-fatal.
 *
 * The screenshot is hard-capped at CHAT_SCREENSHOT_TIMEOUT_MS because Claude
 * Desktop/web clients abandon tool results after ~30s. A slow Playwright load
 * on top of a long planner run can exceed that window, and the user sees
 * "Tool result could not be submitted." On timeout we degrade to a note
 * instead of blocking the whole response.
 */
const CHAT_SCREENSHOT_TIMEOUT_MS = 8000

export async function chatResult(
  client: OrchestratorClient,
  payload: ChatResult,
  opts: { screenshot?: boolean } = {}
) {
  const content: ToolContent[] = [
    { type: "text", text: JSON.stringify(payload, null, 2) },
  ]
  const shouldShoot = opts.screenshot !== false && payload.status === "applied"
  const slug = payload.undoSlug ?? payload.mentionedSlugs?.[0]
  if (shouldShoot && slug) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHAT_SCREENSHOT_TIMEOUT_MS)
    try {
      const shot = await client.request<ScreenshotResponse>("POST", "/preview/screenshot", {
        body: client.scopedBody({ slug }),
        signal: controller.signal,
      })
      content.push({
        type: "text",
        text: `Preview of ${shot.url} (draft, ${shot.width}×${shot.height})`,
      })
      content.push({ type: "image", data: shot.base64, mimeType: shot.mimeType })
    } catch (err) {
      const aborted = controller.signal.aborted
      const reason = aborted
        ? `timeout after ${CHAT_SCREENSHOT_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err)
      content.push({ type: "text", text: `(screenshot skipped: ${reason})` })
    } finally {
      clearTimeout(timer)
    }
  }
  return { content }
}
