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
