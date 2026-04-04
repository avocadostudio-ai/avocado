/**
 * Agent loop tests — tests the provider-agnostic runAgentLoop entry point
 * and event contract using setRunAgentLoopForTests mock injection.
 *
 * Does NOT call real LLM APIs.
 */

import { describe, it, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  runAgentLoop,
  setRunAgentLoopForTests,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentTokenUsage,
} from "./agent-loop.js"

afterEach(() => {
  setRunAgentLoopForTests() // reset
})

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Provider dispatch
// ---------------------------------------------------------------------------

describe("runAgentLoop dispatch", () => {
  it("uses override when setRunAgentLoopForTests is set", async () => {
    let capturedProvider: string | undefined

    setRunAgentLoopForTests(async function* (opts: AgentLoopOptions) {
      capturedProvider = opts.provider
      yield { type: "done", summary: "mocked", toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test",
      provider: "anthropic",
      model: "test-model",
      systemPrompt: "test",
      tools: [],
      userMessage: "hello",
    }))

    assert.equal(capturedProvider, "anthropic")
    assert.equal(events.length, 1)
    assert.equal(events[0].type, "done")
  })

  it("passes all options to the mock", async () => {
    let capturedOpts: AgentLoopOptions | undefined

    setRunAgentLoopForTests(async function* (opts: AgentLoopOptions) {
      capturedOpts = opts
      yield { type: "done", summary: "ok", toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    await collectEvents(runAgentLoop({
      apiKey: "sk-test-key",
      provider: "openai",
      model: "gpt-4o",
      systemPrompt: "You are a test",
      tools: [],
      userMessage: "test message",
      maxToolCalls: 5,
    }))

    assert.ok(capturedOpts)
    assert.equal(capturedOpts!.apiKey, "sk-test-key")
    assert.equal(capturedOpts!.provider, "openai")
    assert.equal(capturedOpts!.model, "gpt-4o")
    assert.equal(capturedOpts!.systemPrompt, "You are a test")
    assert.equal(capturedOpts!.userMessage, "test message")
    assert.equal(capturedOpts!.maxToolCalls, 5)
  })
})

// ---------------------------------------------------------------------------
// Event contract
// ---------------------------------------------------------------------------

describe("agent event contract", () => {
  it("text_delta events have text string", async () => {
    setRunAgentLoopForTests(async function* () {
      yield { type: "text_delta", text: "Hello" }
      yield { type: "text_delta", text: " world" }
      yield { type: "done", summary: "Hello world", toolCallCount: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    const deltas = events.filter((e) => e.type === "text_delta")
    assert.equal(deltas.length, 2)
    for (const d of deltas) {
      assert.ok(d.type === "text_delta" && typeof d.text === "string")
    }
  })

  it("tool_start and tool_done events have toolName and toolUseId", async () => {
    setRunAgentLoopForTests(async function* () {
      yield { type: "tool_start", toolName: "get_page", toolUseId: "tu_1" }
      yield { type: "tool_done", toolName: "get_page", toolUseId: "tu_1", result: '{"slug":"/"}' }
      yield { type: "done", summary: "Done", toolCallCount: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    const start = events.find((e) => e.type === "tool_start")!
    assert.ok(start.type === "tool_start")
    assert.equal(start.toolName, "get_page")
    assert.equal(start.toolUseId, "tu_1")

    const done = events.find((e) => e.type === "tool_done")!
    assert.ok(done.type === "tool_done")
    assert.equal(done.toolName, "get_page")
    assert.equal(done.toolUseId, "tu_1")
    assert.ok(typeof done.result === "string")
  })

  it("tool_done with isError flag indicates tool failure", async () => {
    setRunAgentLoopForTests(async function* () {
      yield { type: "tool_start", toolName: "bad_tool", toolUseId: "tu_err" }
      yield { type: "tool_done", toolName: "bad_tool", toolUseId: "tu_err", result: "Error: not found", isError: true }
      yield { type: "done", summary: "Failed", toolCallCount: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    const done = events.find((e) => e.type === "tool_done")!
    assert.ok(done.type === "tool_done" && done.isError === true)
  })

  it("done event includes summary, toolCallCount, and usage", async () => {
    const expectedUsage: AgentTokenUsage = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
    }

    setRunAgentLoopForTests(async function* () {
      yield { type: "done", summary: "All done!", toolCallCount: 3, usage: expectedUsage }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    const done = events.find((e) => e.type === "done")!
    assert.ok(done.type === "done")
    assert.equal(done.summary, "All done!")
    assert.equal(done.toolCallCount, 3)
    assert.deepEqual(done.usage, expectedUsage)
  })

  it("error event includes message", async () => {
    setRunAgentLoopForTests(async function* () {
      yield { type: "error", message: "Rate limit exceeded" }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    assert.equal(events.length, 1)
    const err = events[0]!
    assert.ok(err.type === "error")
    assert.equal(err.message, "Rate limit exceeded")
  })

  it("handles multi-turn conversation with multiple tools", async () => {
    setRunAgentLoopForTests(async function* () {
      // Turn 1: read page
      yield { type: "tool_start", toolName: "get_page", toolUseId: "tu_1" }
      yield { type: "tool_done", toolName: "get_page", toolUseId: "tu_1", result: '{"slug":"/","blocks":[]}' }
      // Turn 2: update
      yield { type: "tool_start", toolName: "batch_update_props", toolUseId: "tu_2" }
      yield { type: "tool_done", toolName: "batch_update_props", toolUseId: "tu_2", result: '{"status":"applied","appliedCount":1}' }
      // Turn 3: text response
      yield { type: "text_delta", text: "I updated the heading." }
      yield { type: "done", summary: "I updated the heading.", toolCallCount: 2, usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 } }
    })

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test", provider: "anthropic", model: "m", systemPrompt: "s", tools: [], userMessage: "u",
    }))

    const starts = events.filter((e) => e.type === "tool_start")
    const dones = events.filter((e) => e.type === "tool_done")
    const deltas = events.filter((e) => e.type === "text_delta")
    const finals = events.filter((e) => e.type === "done")

    assert.equal(starts.length, 2)
    assert.equal(dones.length, 2)
    assert.equal(deltas.length, 1)
    assert.equal(finals.length, 1)
  })
})

// ---------------------------------------------------------------------------
// Abort signal handling (uses real runAgentLoop, no mock)
// ---------------------------------------------------------------------------

describe("abort signal", () => {
  it("yields error when signal is already aborted", async () => {
    // Reset the mock so we use the real loop
    setRunAgentLoopForTests()

    const controller = new AbortController()
    controller.abort()

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test-abort",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      tools: [],
      userMessage: "hello",
      signal: controller.signal,
    }))

    // Should yield an error event because signal is already aborted
    assert.ok(events.length >= 1)
    const last = events[events.length - 1]!
    assert.equal(last.type, "error")
  })
})
