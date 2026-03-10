import test from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"

let sessionCounter = 0
function newSession() {
  return `chat-contract-test-${++sessionCounter}`
}

function parseSseData(body: string) {
  const events: Array<Record<string, unknown>> = []
  const chunks = body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  for (const chunk of chunks) {
    const line = chunk
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("data:"))
    if (!line) continue
    const raw = line.slice("data:".length).trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      events.push(parsed)
    } catch {
      // ignore malformed non-JSON lines
    }
  }
  return events
}

test("POST /ops contract: applied response includes stable fields", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      ops: [
        {
          op: "update_props",
          pageSlug: "/",
          blockId: "b_hero_home",
          patch: { heading: "Contract heading" }
        }
      ]
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as Record<string, unknown>
  assert.equal(payload.status, "applied")
  assert.equal(typeof payload.summary, "string")
  assert.ok(Array.isArray(payload.changes))
  assert.ok(Array.isArray(payload.mentionedSlugs))
  assert.equal(typeof payload.previewVersion, "number")
})

test("POST /chat contract: info query returns stable payload shape", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "what can i edit on this page?"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as Record<string, unknown>
  assert.equal(payload.status, "info")
  assert.equal(typeof payload.summary, "string")
  assert.ok(Array.isArray(payload.changes))
  assert.ok(
    payload.suggestions === undefined ||
      (Array.isArray(payload.suggestions) && payload.suggestions.every((item) => typeof item === "string"))
  )
  assert.equal(typeof payload.previewVersion, "number")
  assert.ok(payload.plannerSource === "openai" || payload.plannerSource === "demo")
  assert.equal(typeof payload.modelUsed, "string")
  assert.ok(typeof payload.modelKey === "string")
})

test("POST /chat contract: validation error shape is stable when message is missing", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/"
    }
  })

  assert.equal(response.statusCode, 400)
  const payload = response.json() as Record<string, unknown>
  assert.equal(typeof payload.error, "string")
  assert.match(String(payload.error), /message is required/i)
})

test("GET /chat/stream contract: emits status and final events with structured result", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "GET",
    url: `/chat/stream?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}&message=${encodeURIComponent("what can i edit on this page?")}`
  })

  assert.equal(response.statusCode, 200)
  const events = parseSseData(response.body)
  assert.ok(events.length > 0, "SSE should emit at least one event")

  const statusEvent = events.find((event) => event.type === "status")
  assert.ok(statusEvent, "SSE should emit status event")

  const finalEvent = events.find((event) => event.type === "final")
  assert.ok(finalEvent, "SSE should emit final event")

  const result = (finalEvent as { result?: Record<string, unknown> }).result
  assert.ok(result, "final event should include result")
  assert.equal(typeof result?.status, "string")
  assert.equal(typeof result?.summary, "string")
  assert.equal(typeof result?.previewVersion, "number")
})

// --- Two-phase streaming (POST /chat/start + GET /chat/stream?streamId=...) ---

test("POST /chat/start returns a streamId", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { session, slug: "/", message: "hello" }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { streamId?: string }
  assert.equal(typeof payload.streamId, "string")
  assert.ok(payload.streamId!.length > 0)
})

test("POST /chat/start rejects missing session", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { slug: "/", message: "hello" }
  })

  assert.equal(response.statusCode, 400)
  const payload = response.json() as { error?: string }
  assert.ok(payload.error)
})

test("GET /chat/stream with streamId: full two-phase round-trip", async () => {
  const session = newSession()
  const startRes = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { session, slug: "/", message: "what can i edit on this page?" }
  })
  assert.equal(startRes.statusCode, 200)
  const { streamId } = startRes.json() as { streamId: string }

  const streamRes = await app.inject({
    method: "GET",
    url: `/chat/stream?streamId=${streamId}`
  })
  assert.equal(streamRes.statusCode, 200)
  const events = parseSseData(streamRes.body)
  assert.ok(events.length > 0, "should emit SSE events")

  const finalEvent = events.find((event) => event.type === "final")
  assert.ok(finalEvent, `should emit final event, got types: ${events.map((e) => e.type).join(",")}`)
  const result = (finalEvent as { result?: Record<string, unknown> }).result
  assert.ok(result, "final event should include result")
  assert.equal(typeof result?.status, "string")
})

test("GET /chat/stream with invalid streamId returns 410", async () => {
  const streamRes = await app.inject({
    method: "GET",
    url: "/chat/stream?streamId=nonexistent-id"
  })
  assert.equal(streamRes.statusCode, 410)
  const payload = streamRes.json() as { error?: string }
  assert.ok(payload.error)
})

test("GET /chat/stream with completed streamId returns 410", async () => {
  const session = newSession()
  const startRes = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { session, slug: "/", message: "hello" }
  })
  const { streamId } = startRes.json() as { streamId: string }

  // First connect — consumes the stream
  await app.inject({ method: "GET", url: `/chat/stream?streamId=${streamId}` })

  // Second connect — should reject (done state)
  const retryRes = await app.inject({ method: "GET", url: `/chat/stream?streamId=${streamId}` })
  assert.equal(retryRes.statusCode, 410)
})

test("POST /chat/start enforces max pending per session", async () => {
  const session = newSession()
  const siteId = "test-site"

  // Create 3 pending starts (the max)
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/chat/start",
      headers: { "content-type": "application/json" },
      payload: { session, siteId, slug: "/", message: `msg ${i}` }
    })
    assert.equal(res.statusCode, 200)
  }

  // 4th should be rejected
  const res = await app.inject({
    method: "POST",
    url: "/chat/start",
    headers: { "content-type": "application/json" },
    payload: { session, siteId, slug: "/", message: "overflow" }
  })
  assert.equal(res.statusCode, 429)
})
