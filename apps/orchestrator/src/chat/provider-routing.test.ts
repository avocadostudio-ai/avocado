import test from "node:test"
import assert from "node:assert/strict"
import { resolveEffectiveProvider, resolveModelKeyForProvider, resolvePlannerSource } from "./provider-routing.js"
import type { AIProvider, ModelKey } from "../state/session-state.js"

const MODEL_LOOKUP: Record<AIProvider, Record<ModelKey, string>> = {
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    reasoning: "o1",
    codex: "o3"
  },
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    balanced: "claude-sonnet-4-6",
    reasoning: "claude-sonnet-4-6",
    codex: "claude-opus-4-6"
  },
  gemini: {
    fast: "gemini-2.5-flash",
    balanced: "gemini-2.5-flash",
    reasoning: "gemini-2.5-pro",
    codex: "gemini-2.5-pro"
  }
}

function withApiKeys(args: { openai?: string; anthropic?: string }, fn: () => void) {
  const prevOpenAI = process.env.OPENAI_API_KEY
  const prevAnthropic = process.env.ANTHROPIC_API_KEY
  if (args.openai === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = args.openai
  if (args.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = args.anthropic

  try {
    fn()
  } finally {
    if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAI
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevAnthropic
  }
}

test("resolveEffectiveProvider keeps requested provider when available", () => {
  const provider = resolveEffectiveProvider({
    requestedProvider: "anthropic",
    availableProviders: ["openai", "anthropic"],
    fallbackProvider: "openai"
  })
  assert.equal(provider, "anthropic")
})

test("resolveEffectiveProvider uses fallback provider when request is unavailable", () => {
  const provider = resolveEffectiveProvider({
    requestedProvider: "anthropic",
    availableProviders: ["openai"],
    fallbackProvider: "openai"
  })
  assert.equal(provider, "openai")
})

test("resolveModelKeyForProvider keeps valid requested key", () => {
  const modelKey = resolveModelKeyForProvider({
    requestedModelKey: "reasoning",
    provider: "openai",
    modelLookup: MODEL_LOOKUP,
    defaultModelKey: "balanced"
  })
  assert.equal(modelKey, "reasoning")
})

test("resolveModelKeyForProvider falls back to default key", () => {
  const modelKey = resolveModelKeyForProvider({
    provider: "anthropic",
    modelLookup: MODEL_LOOKUP,
    defaultModelKey: "balanced"
  })
  assert.equal(modelKey, "balanced")
})

test("resolvePlannerSource prefers requested anthropic provider when key is present", () => {
  withApiKeys({ anthropic: "test-anthropic" }, () => {
    assert.equal(resolvePlannerSource("anthropic"), "anthropic")
  })
})

test("resolvePlannerSource prefers requested openai provider when key is present", () => {
  withApiKeys({ openai: "test-openai" }, () => {
    assert.equal(resolvePlannerSource("openai"), "openai")
  })
})

test("resolvePlannerSource falls back to available provider keys", () => {
  withApiKeys({ anthropic: "test-anthropic" }, () => {
    assert.equal(resolvePlannerSource("openai"), "anthropic")
  })
})

test("resolvePlannerSource returns demo when no provider keys exist", () => {
  withApiKeys({}, () => {
    assert.equal(resolvePlannerSource("openai"), "demo")
  })
})
