import test from "node:test"
import assert from "node:assert/strict"
import { extractUsage } from "./usage.js"

test("extractUsage reads Anthropic cache usage fields", () => {
  const usage = extractUsage({
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: 450
    }
  })

  assert.equal(usage.inputTokens, 1200)
  assert.equal(usage.outputTokens, 300)
  assert.equal(usage.totalTokens, 1500)
  assert.equal(usage.cacheCreationInputTokens, 900)
  assert.equal(usage.cacheReadInputTokens, 450)
})

test("extractUsage reads OpenAI cached tokens for chat.completions", () => {
  const usage = extractUsage({
    usage: {
      prompt_tokens: 700,
      completion_tokens: 120,
      total_tokens: 820,
      prompt_tokens_details: { cached_tokens: 256 }
    }
  })

  assert.equal(usage.inputTokens, 700)
  assert.equal(usage.outputTokens, 120)
  assert.equal(usage.totalTokens, 820)
  assert.equal(usage.cacheReadInputTokens, 256)
  assert.equal(usage.cacheCreationInputTokens, undefined)
})

test("extractUsage reads OpenAI cached tokens for responses API", () => {
  const usage = extractUsage({
    usage: {
      input_tokens: 840,
      output_tokens: 160,
      input_tokens_details: { cached_tokens: 300 }
    }
  })

  assert.equal(usage.inputTokens, 840)
  assert.equal(usage.outputTokens, 160)
  assert.equal(usage.totalTokens, 1000)
  assert.equal(usage.cacheReadInputTokens, 300)
})
