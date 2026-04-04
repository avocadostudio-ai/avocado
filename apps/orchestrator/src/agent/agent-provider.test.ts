/**
 * Agent provider detection and configuration tests.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  detectProviderFromKey,
  resolveAgentModel,
  shouldUseThinking,
  AGENT_MAX_TOOL_CALLS,
  AGENT_MAX_TOKENS,
  AGENT_TEMPERATURE,
  AGENT_THINKING_BUDGET,
} from "./agent-provider.js"

// ---------------------------------------------------------------------------
// detectProviderFromKey
// ---------------------------------------------------------------------------

describe("detectProviderFromKey", () => {
  it("returns 'anthropic' for sk-ant- prefix", () => {
    assert.equal(detectProviderFromKey("sk-ant-abc123"), "anthropic")
  })

  it("returns 'anthropic' for full Anthropic key format", () => {
    assert.equal(detectProviderFromKey("sk-ant-api03-xxxxxxx"), "anthropic")
  })

  it("returns 'openai' for sk- prefix (non-Anthropic)", () => {
    assert.equal(detectProviderFromKey("sk-proj-abc123"), "openai")
    assert.equal(detectProviderFromKey("sk-abc123"), "openai")
  })

  it("returns null for unrecognized key formats", () => {
    assert.equal(detectProviderFromKey("bad-key"), null)
    assert.equal(detectProviderFromKey(""), null)
    assert.equal(detectProviderFromKey("xai-abc123"), null)
    assert.equal(detectProviderFromKey("AIzaSy-google-key"), null)
  })

  it("does not match partial prefixes", () => {
    // "sk" without hyphen should not match
    assert.equal(detectProviderFromKey("skant123"), null)
  })
})

// ---------------------------------------------------------------------------
// resolveAgentModel
// ---------------------------------------------------------------------------

describe("resolveAgentModel", () => {
  it("returns requested model when provided", () => {
    assert.equal(resolveAgentModel("anthropic", "claude-opus-4-6"), "claude-opus-4-6")
    assert.equal(resolveAgentModel("openai", "gpt-4-turbo"), "gpt-4-turbo")
  })

  it("trims whitespace from requested model", () => {
    assert.equal(resolveAgentModel("anthropic", "  claude-opus-4-6  "), "claude-opus-4-6")
  })

  it("falls back to default when no model requested", () => {
    const anthropicModel = resolveAgentModel("anthropic")
    assert.ok(typeof anthropicModel === "string")
    assert.ok(anthropicModel.length > 0)

    const openaiModel = resolveAgentModel("openai")
    assert.ok(typeof openaiModel === "string")
    assert.ok(openaiModel.length > 0)
  })

  it("falls back to default when empty string", () => {
    const model = resolveAgentModel("anthropic", "")
    assert.ok(model.length > 0)
  })

  it("falls back to default when whitespace only", () => {
    const model = resolveAgentModel("openai", "   ")
    assert.ok(model.length > 0)
  })
})

// ---------------------------------------------------------------------------
// shouldUseThinking
// ---------------------------------------------------------------------------

describe("shouldUseThinking", () => {
  it("returns true for structural keywords", () => {
    assert.equal(shouldUseThinking("redesign the entire page"), true)
    assert.equal(shouldUseThinking("restructure the layout"), true)
    assert.equal(shouldUseThinking("rewrite all sections"), true)
    assert.equal(shouldUseThinking("overhaul the page content"), true)
    assert.equal(shouldUseThinking("create a new page for pricing"), true)
    assert.equal(shouldUseThinking("build a new page with FAQ"), true)
  })

  it("returns true for multi-block hints", () => {
    assert.equal(shouldUseThinking("update all the sections"), true)
    assert.equal(shouldUseThinking("change every block color"), true)
    assert.equal(shouldUseThinking("hero and features need updating"), true)
    assert.equal(shouldUseThinking("edit multiple sections"), true)
    assert.equal(shouldUseThinking("changes across the site"), true)
  })

  it("returns true for long messages with structural verbs", () => {
    const longMsg = "I want to add a testimonials section with quotes from our customers about how the product improved their workflow and helped them save time on daily tasks"
    assert.ok(longMsg.length > 120)
    assert.equal(shouldUseThinking(longMsg), true)
  })

  it("returns false for simple edits", () => {
    assert.equal(shouldUseThinking("change the heading to Hello"), false)
    assert.equal(shouldUseThinking("update the CTA text"), false)
    assert.equal(shouldUseThinking("fix typo in hero"), false)
  })

  it("extracts user request part after context prefix", () => {
    // The context message prepends "User request:" — shouldUseThinking should only check after that
    const withContext = "Current page: / ... Blocks: Hero, CTA\n\n---\n\nUser request: change heading"
    assert.equal(shouldUseThinking(withContext), false)

    const withComplexRequest = "Current page: / ... Blocks: Hero, CTA\n\n---\n\nUser request: redesign the entire page"
    assert.equal(shouldUseThinking(withComplexRequest), true)
  })
})

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

describe("agent configuration constants", () => {
  it("has reasonable default values", () => {
    assert.ok(AGENT_MAX_TOOL_CALLS >= 10, "Max tool calls should be at least 10")
    assert.ok(AGENT_MAX_TOKENS >= 4096, "Max tokens should be at least 4096")
    assert.ok(AGENT_TEMPERATURE >= 0, "Temperature should be non-negative")
    assert.ok(AGENT_THINKING_BUDGET >= 0, "Thinking budget should be non-negative")
  })
})
