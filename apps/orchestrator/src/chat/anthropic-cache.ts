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

export function anthropicToolWithCache(tool: Anthropic.Messages.Tool): Anthropic.Messages.Tool {
  const cacheControl = anthropicPromptCacheControl()
  if (!cacheControl) return tool
  return { ...tool, cache_control: cacheControl }
}
