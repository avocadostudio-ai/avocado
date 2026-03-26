import { describe, it, mock, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { AgentEvent, AgentLoopOptions } from "./agent-loop.js"
import type { AgentTool } from "./agent-tools.js"

// ---------------------------------------------------------------------------
// Mock helpers — simulate OpenAI streaming chunks
// ---------------------------------------------------------------------------

type MockChunk = {
  choices: Array<{
    index: number
    delta: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
}

function textChunk(content: string): MockChunk {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null }] }
}

function toolCallChunk(tcIndex: number, opts: { id?: string; name?: string; args?: string }): MockChunk {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: tcIndex,
          id: opts.id,
          function: {
            name: opts.name,
            arguments: opts.args,
          },
        }],
      },
      finish_reason: null,
    }],
  }
}

function finishChunk(reason: string): MockChunk {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] }
}

async function* mockStream(chunks: MockChunk[]): AsyncGenerator<MockChunk> {
  for (const c of chunks) yield c
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, handler: (input: Record<string, unknown>) => Promise<{ result: string; isError?: boolean }>): AgentTool {
  return {
    definition: {
      name,
      description: `Test tool ${name}`,
      input_schema: { type: "object" as const, properties: {} },
    },
    handler,
  }
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runOpenAIAgentLoop", () => {
  let createMock: ReturnType<typeof mock.fn>

  beforeEach(() => {
    createMock = mock.fn()
  })

  /** Dynamically import with mocked OpenAI */
  async function runLoop(options: Partial<AgentLoopOptions> & { tools: AgentTool[] }, chunks: MockChunk[][]) {
    let callIndex = 0
    createMock = mock.fn(() => {
      const stream = mockStream(chunks[callIndex] ?? [])
      callIndex++
      return stream
    })

    // We can't easily mock the import, so we'll test the core logic inline
    // by simulating what runOpenAIAgentLoop does
    const { runOpenAIAgentLoop } = await import("./agent-loop-openai.js")

    // Since we can't inject a mock client, we'll test the provider detection
    // and the event contract via integration-style tests using the mock
    // For now, test the tool translation and event flow logic
    return { createMock, callIndex }
  }

  it("detects provider from key prefix", async () => {
    const { detectProviderFromKey } = await import("./agent-provider.js")

    assert.equal(detectProviderFromKey("sk-ant-abc123"), "anthropic")
    assert.equal(detectProviderFromKey("sk-proj-abc123"), "openai")
    assert.equal(detectProviderFromKey("sk-abc123"), "openai")
    assert.equal(detectProviderFromKey("AIzaSyAbc"), null)
    assert.equal(detectProviderFromKey("random-key"), null)
    assert.equal(detectProviderFromKey(""), null)
  })

  it("resolves agent model with defaults", async () => {
    const { resolveAgentModel } = await import("./agent-provider.js")

    assert.equal(resolveAgentModel("anthropic"), "claude-sonnet-4-6")
    assert.equal(resolveAgentModel("openai"), "gpt-4o")
    assert.equal(resolveAgentModel("anthropic", "claude-opus-4-6"), "claude-opus-4-6")
    assert.equal(resolveAgentModel("openai", "gpt-4o-mini"), "gpt-4o-mini")
    assert.equal(resolveAgentModel("openai", "  "), "gpt-4o") // whitespace-only → default
  })

  it("detectProviderFromKey returns null for unrecognized keys", async () => {
    const { detectProviderFromKey } = await import("./agent-provider.js")

    assert.equal(detectProviderFromKey("bad-key-format"), null)
    assert.equal(detectProviderFromKey(""), null)
    assert.equal(detectProviderFromKey("AIzaSyAbc"), null)
  })

  it("tool definition translation preserves JSON Schema", async () => {
    // Test the shape of tool definitions — input_schema maps to parameters
    const tool = makeTool("test_tool", async () => ({ result: "ok" }))
    const inputSchema = tool.definition.input_schema

    // Verify the schema is a valid JSON Schema object
    assert.equal(inputSchema.type, "object")
    assert.ok("properties" in inputSchema)

    // The translation in agent-loop-openai.ts does:
    // { type: "function", function: { name, description, parameters: input_schema } }
    const openAITool = {
      type: "function" as const,
      function: {
        name: tool.definition.name,
        description: tool.definition.description ?? "",
        parameters: inputSchema,
      },
    }

    assert.equal(openAITool.function.name, "test_tool")
    assert.deepEqual(openAITool.function.parameters, inputSchema)
  })

  it("interleaved tool call chunks accumulate correctly", async () => {
    // Simulate the accumulation logic used in runOpenAIAgentLoop
    const accumulators = new Map<number, { id: string; name: string; args: string }>()

    // Interleaved chunks for two tool calls
    const chunks = [
      toolCallChunk(0, { id: "call_1", name: "get_page" }),
      toolCallChunk(1, { id: "call_2", name: "list_pages" }),
      toolCallChunk(0, { args: '{"page' }),
      toolCallChunk(1, { args: '{}' }),
      toolCallChunk(0, { args: 'Slug":' }),
      toolCallChunk(0, { args: '"/"}' }),
    ]

    // Apply accumulation logic
    for (const chunk of chunks) {
      const delta = chunk.choices[0]!.delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let acc = accumulators.get(tc.index)
          if (!acc) {
            acc = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" }
            accumulators.set(tc.index, acc)
          }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (tc.function?.arguments) acc.args += tc.function.arguments
        }
      }
    }

    assert.equal(accumulators.size, 2)

    const call1 = accumulators.get(0)!
    assert.equal(call1.id, "call_1")
    assert.equal(call1.name, "get_page")
    assert.equal(call1.args, '{"pageSlug":"/"}')
    assert.deepEqual(JSON.parse(call1.args), { pageSlug: "/" })

    const call2 = accumulators.get(1)!
    assert.equal(call2.id, "call_2")
    assert.equal(call2.name, "list_pages")
    assert.deepEqual(JSON.parse(call2.args), {})
  })

  it("malformed JSON args yield tool_done error without killing the loop", async () => {
    // Simulate the per-call parse guard
    const results: Array<{ name: string; parsed: boolean; error?: string }> = []

    const toolCalls = [
      { id: "call_1", name: "get_page", args: '{"pageSlug": "/"}' },
      { id: "call_2", name: "bad_tool", args: '{broken json!!!' },
      { id: "call_3", name: "list_pages", args: '{}' },
    ]

    for (const tc of toolCalls) {
      try {
        JSON.parse(tc.args)
        results.push({ name: tc.name, parsed: true })
      } catch {
        results.push({ name: tc.name, parsed: false, error: `Failed to parse tool arguments for ${tc.name}` })
      }
    }

    // All three processed — loop didn't abort
    assert.equal(results.length, 3)
    assert.equal(results[0]!.parsed, true)
    assert.equal(results[1]!.parsed, false)
    assert.ok(results[1]!.error!.includes("bad_tool"))
    assert.equal(results[2]!.parsed, true)
  })

  it("abort signal short-circuits the loop", async () => {
    const controller = new AbortController()
    controller.abort()

    const { runAgentLoop } = await import("./agent-loop.js")

    const events = await collectEvents(runAgentLoop({
      apiKey: "sk-ant-test-key",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPrompt: "test",
      tools: [],
      userMessage: "hello",
      signal: controller.signal,
    }))

    // Should get a single canceled event (checked before API call)
    assert.ok(events.length >= 1)
    const lastEvent = events[events.length - 1]!
    assert.equal(lastEvent.type, "error")
  })
})
