// ---------------------------------------------------------------------------
// Token usage tracking — extracted from benchmark-models.ts for reuse
// ---------------------------------------------------------------------------

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

/**
 * Extract token usage from an OpenAI or Anthropic API response object.
 * Handles both `prompt_tokens`/`completion_tokens` (OpenAI) and
 * `input_tokens`/`output_tokens` (Anthropic) naming conventions.
 */
export function extractUsage(source: unknown): TokenUsage {
  const usage = (source as { usage?: unknown } | null)?.usage as Record<string, unknown> | undefined
  if (!usage) return { ...ZERO_USAGE }

  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : promptTokens
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : completionTokens
  const totalTokens =
    typeof usage.total_tokens === "number" ? usage.total_tokens : Math.max(0, inputTokens) + Math.max(0, outputTokens)
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    totalTokens: Math.max(0, totalTokens)
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** USD per 1 million tokens. Keys use prefix matching. */
export const USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-5": { input: 1.75, output: 14 },
  "claude-haiku": { input: 0.8, output: 4 },
  "claude-sonnet": { input: 3, output: 15 },
  "claude-opus": { input: 15, output: 75 }
}

/**
 * Estimate the USD cost for a given model and token usage.
 * Uses exact key match first, then falls back to prefix matching.
 */
export function estimateUsd(model: string, usage: TokenUsage): number | null {
  const pricing = USD_PER_MTOK[model] ?? USD_PER_MTOK[Object.keys(USD_PER_MTOK).find((key) => model.startsWith(key)) ?? ""]
  if (!pricing) return null
  return (usage.inputTokens / 1_000_000) * pricing.input + (usage.outputTokens / 1_000_000) * pricing.output
}
