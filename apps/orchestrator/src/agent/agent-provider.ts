/**
 * Agent provider detection and configuration.
 * Strict prefix matching — no async probing, no fallback.
 *
 * All AGENT_* env vars configure agent mode specifically (user-supplied API key).
 * They do NOT affect the regular chat pipeline.
 */

import type { AIProvider } from "../state/session-state.js"

/** Providers currently supported in agent mode. */
export type AgentProvider = Extract<AIProvider, "anthropic" | "openai">

/**
 * Detect AI provider from API key prefix.
 * Returns null for unrecognized formats — caller should reject with a descriptive error.
 */
export function detectProviderFromKey(key: string): AgentProvider | null {
  if (key.startsWith("sk-ant-")) return "anthropic"
  if (key.startsWith("sk-")) return "openai"
  return null
}

// ---------------------------------------------------------------------------
// Agent mode defaults (env-configurable)
// ---------------------------------------------------------------------------

const DEFAULT_MODELS: Record<AgentProvider, string> = {
  anthropic: process.env.AGENT_ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  openai: process.env.AGENT_OPENAI_MODEL ?? "gpt-4o",
}

/** Max tool calls before the agent loop stops. */
export const AGENT_MAX_TOOL_CALLS = Number(process.env.AGENT_MAX_TOOL_CALLS) || 20

/** Max tokens for agent responses. Higher allows longer reasoning and multi-step summaries. */
export const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS) || 16384

/** Temperature for agent mode. 0 = deterministic edits. */
export const AGENT_TEMPERATURE = (() => {
  const raw = process.env.AGENT_TEMPERATURE?.trim()
  if (raw === undefined || raw === "") return 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
})()

/** Extended thinking token budget. 0 = disabled entirely. */
export const AGENT_THINKING_BUDGET = Number(process.env.AGENT_THINKING_BUDGET) || 10000

/** Resolve a concrete model ID for the given provider, falling back to provider default. */
export function resolveAgentModel(provider: AgentProvider, requestedModel?: string): string {
  if (requestedModel?.trim()) return requestedModel.trim()
  return DEFAULT_MODELS[provider]
}

// ---------------------------------------------------------------------------
// Complexity detection for extended thinking
// ---------------------------------------------------------------------------

const STRUCTURAL_KEYWORDS = /\b(redesign|restructure|rewrite\s+all|create\s+(?:a\s+)?(?:new\s+)?page|build\s+(?:a\s+)?(?:new\s+)?page|add\s+\w+\s+sections?|overhaul|rework|redo\s+the)\b/i
const MULTI_BLOCK_HINTS = /\b(hero\s+and\s+\w+|all\s+(?:the\s+)?(?:sections?|blocks?|pages?)|every\s+(?:section|block|page)|each\s+(?:section|block|page)|multiple\s+(?:sections?|blocks?)|across\s+(?:the\s+)?(?:site|page))\b/i
const STRUCTURAL_VERBS = /\b(add|create|move|reorder|replace|remove|duplicate|insert)\b/i

/**
 * Detect whether a user message is complex enough to benefit from extended thinking.
 * Returns true for multi-step structural edits, false for simple field updates.
 */
export function shouldUseThinking(message: string): boolean {
  if (AGENT_THINKING_BUDGET <= 0) return false

  // Extract just the user request part (after "User request:" if present)
  const userPart = message.includes("User request:") ? message.split("User request:").pop()! : message

  if (STRUCTURAL_KEYWORDS.test(userPart)) return true
  if (MULTI_BLOCK_HINTS.test(userPart)) return true
  if (userPart.length > 120 && STRUCTURAL_VERBS.test(userPart)) return true

  return false
}
