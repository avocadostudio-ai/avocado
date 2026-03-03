import test from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import { anthropicPromptCacheControl, anthropicSystemPromptWithCache, anthropicToolWithCache } from "./anthropic-cache.js"

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test("prompt caching is disabled by default", () => {
  withEnv({ ANTHROPIC_PROMPT_CACHE: undefined, ANTHROPIC_PROMPT_CACHE_TTL: undefined }, () => {
    assert.equal(anthropicPromptCacheControl(), undefined)
    const system = anthropicSystemPromptWithCache("system text")
    assert.equal(system, "system text")
  })
})

test("prompt caching enables ephemeral cache control", () => {
  withEnv({ ANTHROPIC_PROMPT_CACHE: "1", ANTHROPIC_PROMPT_CACHE_TTL: undefined }, () => {
    assert.deepEqual(anthropicPromptCacheControl(), { type: "ephemeral" })
    const system = anthropicSystemPromptWithCache("system text")
    assert.deepEqual(system, [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }])
  })
})

test("prompt caching supports 1h TTL", () => {
  withEnv({ ANTHROPIC_PROMPT_CACHE: "true", ANTHROPIC_PROMPT_CACHE_TTL: "1h" }, () => {
    assert.deepEqual(anthropicPromptCacheControl(), { type: "ephemeral", ttl: "1h" })
  })
})

test("tool definitions receive cache control when enabled", () => {
  withEnv({ ANTHROPIC_PROMPT_CACHE: "on", ANTHROPIC_PROMPT_CACHE_TTL: "5m" }, () => {
    const tool: Anthropic.Messages.Tool = {
      name: "submit_edit_plan",
      description: "Submit plan",
      input_schema: { type: "object", properties: {} }
    }
    const cached = anthropicToolWithCache(tool)
    assert.deepEqual(cached, { ...tool, cache_control: { type: "ephemeral", ttl: "5m" } })
  })
})
