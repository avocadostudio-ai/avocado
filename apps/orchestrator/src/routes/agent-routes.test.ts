/**
 * Agent route integration tests.
 *
 * Tests the HTTP endpoints in /agent/* using Fastify .inject().
 * Uses setRunAgentLoopForTests() to mock the LLM loop for streaming tests.
 */

import { describe, it, before, afterEach } from "node:test"
import assert from "node:assert/strict"
import { app } from "../index.js"
import { setRunAgentLoopForTests, type AgentEvent, type AgentLoopOptions } from "../agent/agent-loop.js"
import { createSessionFactory, seedSession, makeHomePage, parseSseData } from "../test/fixtures.js"

const newSession = createSessionFactory("agent-route-test")

// Set a valid agent API key for all tests (server-side key)
before(() => {
  process.env.AGENT_API_KEY = "sk-ant-test-key-for-routes"
})

afterEach(() => {
  setRunAgentLoopForTests() // reset mock
})

// ---------------------------------------------------------------------------
// Helper: create a mock agent loop that yields a controlled sequence of events
// ---------------------------------------------------------------------------
function mockAgentLoop(events: AgentEvent[]) {
  return async function* (_opts: AgentLoopOptions): AsyncGenerator<AgentEvent> {
    for (const e of events) yield e
  }
}

// ---------------------------------------------------------------------------
// POST /agent/start — validation
// ---------------------------------------------------------------------------

describe("POST /agent/start", () => {
  it("returns 501 when AGENT_API_KEY is not set", async () => {
    const saved = process.env.AGENT_API_KEY
    delete process.env.AGENT_API_KEY
    try {
      const res = await app.inject({
        method: "POST",
        url: "/agent/start",
        headers: { "content-type": "application/json" },
        payload: { message: "hello", siteId: "test-site" },
      })
      assert.equal(res.statusCode, 501)
      const body = res.json() as { error: string }
      assert.ok(body.error.includes("AGENT_API_KEY"))
    } finally {
      process.env.AGENT_API_KEY = saved
    }
  })

  it("returns 500 when AGENT_API_KEY format is unrecognized", async () => {
    const saved = process.env.AGENT_API_KEY
    process.env.AGENT_API_KEY = "bad-key-format"
    try {
      const res = await app.inject({
        method: "POST",
        url: "/agent/start",
        headers: { "content-type": "application/json" },
        payload: { message: "hello", siteId: "test-site" },
      })
      assert.equal(res.statusCode, 500)
      const body = res.json() as { error: string }
      assert.ok(body.error.includes("AGENT_API_KEY"))
    } finally {
      process.env.AGENT_API_KEY = saved
    }
  })

  it("returns 400 when message is empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "", siteId: "test-site" },
    })
    assert.equal(res.statusCode, 400)
    const body = res.json() as { error: string }
    assert.ok(body.error.includes("message"))
  })

  it("returns 400 when siteId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "hello" },
    })
    assert.equal(res.statusCode, 400)
    const body = res.json() as { error: string }
    assert.ok(body.error.includes("siteId"))
  })

  it("returns 200 with streamId when AGENT_API_KEY is valid", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "change heading", siteId: "test-site", session: newSession() },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { streamId: string }
    assert.ok(typeof body.streamId === "string")
    assert.ok(body.streamId.length > 10)
  })
})

// ---------------------------------------------------------------------------
// POST /agent/cancel — validation & lifecycle
// ---------------------------------------------------------------------------

describe("POST /agent/cancel", () => {
  it("returns 400 when streamId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/cancel",
      headers: { "content-type": "application/json" },
      payload: {},
    })
    assert.equal(res.statusCode, 400)
  })

  it("returns 410 when streamId not found", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/cancel",
      headers: { "content-type": "application/json" },
      payload: { streamId: "nonexistent-id" },
    })
    assert.equal(res.statusCode, 410)
  })

  it("returns 200 and cancels a pending stream", async () => {
    // Start a stream first
    const startRes = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "do something", siteId: "test-site", session: newSession() },
    })
    const { streamId } = startRes.json() as { streamId: string }

    // Cancel it
    const cancelRes = await app.inject({
      method: "POST",
      url: "/agent/cancel",
      headers: { "content-type": "application/json" },
      payload: { streamId },
    })
    assert.equal(cancelRes.statusCode, 200)
    const body = cancelRes.json() as { ok: boolean }
    assert.equal(body.ok, true)
  })
})

// ---------------------------------------------------------------------------
// GET /agent/stream — validation
// ---------------------------------------------------------------------------

describe("GET /agent/stream", () => {
  it("returns 400 when streamId is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/stream",
    })
    assert.equal(res.statusCode, 400)
  })

  it("returns 410 when streamId not found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/agent/stream?streamId=nonexistent-id",
    })
    assert.equal(res.statusCode, 410)
  })

  it("streams events from mocked agent loop and ends with final", async () => {
    const session = newSession()
    seedSession(session, makeHomePage())

    setRunAgentLoopForTests(mockAgentLoop([
      { type: "text_delta", text: "I'll update " },
      { type: "text_delta", text: "the heading." },
      { type: "tool_start", toolName: "batch_update_props", toolUseId: "tu_1" },
      { type: "tool_done", toolName: "batch_update_props", toolUseId: "tu_1", result: JSON.stringify({ status: "applied", appliedCount: 1, previewVersion: 2, focusBlockId: "b_hero" }) },
      { type: "done", summary: "I updated the heading.", toolCallCount: 1, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    ]))

    // Start the stream
    const startRes = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "change heading to Hello", siteId: "test-site", session },
    })
    const { streamId } = startRes.json() as { streamId: string }

    // Connect to stream
    const streamRes = await app.inject({
      method: "GET",
      url: `/agent/stream?streamId=${streamId}`,
    })

    // Parse SSE events
    const events = parseSseData(streamRes.body)

    // Should have summary_token, status (tool label), op_applied, and final events
    const summaryTokens = events.filter((e) => e.type === "summary_token")
    assert.ok(summaryTokens.length >= 1, "Should have summary_token events")

    const opApplied = events.find((e) => e.type === "op_applied")
    assert.ok(opApplied, "Should have op_applied event")
    assert.equal((opApplied as Record<string, unknown>).toolName, "batch_update_props")

    const final = events.find((e) => e.type === "final")
    assert.ok(final, "Should have final event")
    const result = (final as { result?: Record<string, unknown> }).result
    assert.ok(result)
    assert.equal(result!.status, "applied")
    assert.ok(typeof result!.summary === "string")
    assert.equal(result!.toolCallCount, 1)
  })

  it("handles agent error event", async () => {
    const session = newSession()
    seedSession(session, makeHomePage())

    setRunAgentLoopForTests(mockAgentLoop([
      { type: "error", message: "API rate limited" },
    ]))

    const startRes = await app.inject({
      method: "POST",
      url: "/agent/start",
      headers: { "content-type": "application/json" },
      payload: { message: "change heading", siteId: "test-site", session },
    })
    const { streamId } = startRes.json() as { streamId: string }

    const streamRes = await app.inject({
      method: "GET",
      url: `/agent/stream?streamId=${streamId}`,
    })

    const events = parseSseData(streamRes.body)
    const errorEvent = events.find((e) => e.type === "error")
    assert.ok(errorEvent, "Should have error event")
    const result = (errorEvent as { result?: Record<string, unknown> }).result
    assert.ok(result)
    assert.equal(result!.status, "error")
    assert.ok((result!.summary as string).includes("rate limited"))
  })
})

// ---------------------------------------------------------------------------
// POST /agent/chat — blocking mode validation
// ---------------------------------------------------------------------------

describe("POST /agent/chat", () => {
  it("returns 501 when AGENT_API_KEY is not set", async () => {
    const saved = process.env.AGENT_API_KEY
    delete process.env.AGENT_API_KEY
    try {
      const res = await app.inject({
        method: "POST",
        url: "/agent/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "hello", siteId: "test-site" },
      })
      assert.equal(res.statusCode, 501)
    } finally {
      process.env.AGENT_API_KEY = saved
    }
  })

  it("returns 400 when message is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { "content-type": "application/json" },
      payload: { siteId: "test-site" },
    })
    assert.equal(res.statusCode, 400)
  })

  it("returns 400 when siteId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { "content-type": "application/json" },
      payload: { message: "hello" },
    })
    assert.equal(res.statusCode, 400)
  })

  it("returns full result with mocked agent loop", async () => {
    const session = newSession()
    seedSession(session, makeHomePage())

    setRunAgentLoopForTests(mockAgentLoop([
      { type: "text_delta", text: "Done!" },
      { type: "tool_start", toolName: "batch_update_props", toolUseId: "tu_1" },
      { type: "tool_done", toolName: "batch_update_props", toolUseId: "tu_1", result: JSON.stringify({ status: "applied", appliedCount: 1 }) },
      { type: "done", summary: "Updated heading.", toolCallCount: 1, usage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    ]))

    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { "content-type": "application/json" },
      payload: { message: "change heading to Hello", siteId: "test-site", session },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as Record<string, unknown>
    assert.equal(body.status, "applied")
    assert.equal(body.summary, "Updated heading.")
    assert.equal(body.toolCallCount, 1)
    assert.ok(body.usage)
    assert.ok(Array.isArray(body.events))
  })

  it("returns 500 on agent loop error", async () => {
    const session = newSession()
    seedSession(session, makeHomePage())

    setRunAgentLoopForTests(async function* () {
      throw new Error("Mock LLM failure")
    })

    const res = await app.inject({
      method: "POST",
      url: "/agent/chat",
      headers: { "content-type": "application/json" },
      payload: { message: "change heading", siteId: "test-site", session },
    })
    assert.equal(res.statusCode, 500)
    const body = res.json() as { status: string; error: string }
    assert.equal(body.status, "error")
    assert.ok(body.error.includes("Mock LLM failure"))
  })
})
