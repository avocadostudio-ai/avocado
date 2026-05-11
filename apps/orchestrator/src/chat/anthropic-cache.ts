import Anthropic from "@anthropic-ai/sdk"

const ENABLED_RE = /^(1|true|yes|on)$/i

function promptCacheEnabled() {
  return ENABLED_RE.test((process.env.ANTHROPIC_PROMPT_CACHE ?? "").trim())
}

function promptCacheTtl(): "5m" | "1h" | undefined {
  const raw = (process.env.ANTHROPIC_PROMPT_CACHE_TTL ?? "").trim()
  if (raw === "5m" || raw === "1h") return raw
  return undefined
}

export function anthropicPromptCacheControl(): Anthropic.CacheControlEphemeral | undefined {
  if (!promptCacheEnabled()) return undefined
  const ttl = promptCacheTtl()
  return ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" }
}

export function anthropicSystemPromptWithCache(system: string): string | Anthropic.TextBlockParam[] {
  const cacheControl = anthropicPromptCacheControl()
  if (!cacheControl) return system
  return [{ type: "text", text: system, cache_control: cacheControl }]
}

/**
 * Wraps a {stable, dynamic} prompt split into Anthropic system content blocks
 * with `cache_control` on the stable prefix only. The dynamic suffix (per-
 * request flags like selected block, locale, conditional modes) is sent as a
 * separate text block without `cache_control`, so changing it does not bust
 * the cache on the stable prefix.
 *
 * When caching is disabled, returns a single joined string for backward compat.
 */
export function anthropicSegmentedSystemPromptWithCache(
  segments: { stable: string; dynamic: string }
): string | Anthropic.TextBlockParam[] {
  const dynamic = segments.dynamic.trim()
  const cacheControl = anthropicPromptCacheControl()
  if (!cacheControl) {
    return dynamic ? `${segments.stable}\n\n${dynamic}` : segments.stable
  }
  const blocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: segments.stable, cache_control: cacheControl }
  ]
  if (dynamic) {
    blocks.push({ type: "text", text: dynamic })
  }
  return blocks
}

export function anthropicToolWithCache(tool: Anthropic.Messages.Tool): Anthropic.Messages.Tool {
  const cacheControl = anthropicPromptCacheControl()
  if (!cacheControl) return tool
  return { ...tool, cache_control: cacheControl }
}

export const ANTHROPIC_FINE_GRAINED_STREAM_HEADERS = {
  "anthropic-beta": "fine-grained-tool-streaming-2025-05-14"
}
