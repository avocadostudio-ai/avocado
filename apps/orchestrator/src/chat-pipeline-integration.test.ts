import test from "node:test"
import assert from "node:assert/strict"
import type { EditPlan } from "@ai-site-editor/shared"
import { app } from "./index.js"
import {
  setDemoPlanFromMessageForTests,
  setGeneratePlanWithOpenAIForTests,
  shouldResolveCreatePageHeroImage
} from "./chat/chat-pipeline.js"
import { ZERO_USAGE } from "./telemetry/usage.js"

let sessionCounter = 0
function newSession() {
  return `chat-pipeline-int-${++sessionCounter}`
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
      events.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // Ignore malformed lines.
    }
  }
  return events
}

test("chat pending-plan lifecycle: plan_only -> apply_pending_plan applies mocked plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const targetHeading = `Planned heading ${Date.now()}`
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading.",
    change_log: ["Changed hero heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: targetHeading } }]
  }

  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading",
      executionMode: "plan_only"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { status?: string; pendingPlanId?: string }
  assert.equal(planPayload.status, "plan_ready")
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

  const applyPending = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan",
      pendingPlanId: planPayload.pendingPlanId
    }
  })
  assert.equal(applyPending.statusCode, 200)
  const applyPayload = applyPending.json() as { status?: string; summary?: string }
  assert.equal(applyPayload.status, "applied")
  assert.match(String(applyPayload.summary), /Updated hero heading/i)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  assert.equal(hero?.props.heading, targetHeading)
})

test("shouldResolveCreatePageHeroImage returns true for local placeholder urls", () => {
  assert.equal(shouldResolveCreatePageHeroImage(""), true)
  assert.equal(shouldResolveCreatePageHeroImage("/hero-generated.svg"), true)
  assert.equal(shouldResolveCreatePageHeroImage("hero-generated.svg"), true)
})

test("shouldResolveCreatePageHeroImage returns false for explicit remote urls", () => {
  assert.equal(shouldResolveCreatePageHeroImage("https://example.com/hero.jpg"), false)
  assert.equal(shouldResolveCreatePageHeroImage("http://example.com/hero.jpg"), false)
})

test("chat applies deterministic plan for high-confidence remove request without calling model planner", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  setGeneratePlanWithOpenAIForTests(async () => {
    throw new Error("model planner should not be called for deterministic remove")
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "remove hero section"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /Removed/i)

  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string }> }
  assert.equal(page.blocks.some((block) => block.id === "b_hero_home"), false)
})

test("chat stream emits op_applied events for mocked multi-op plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero copy.",
    change_log: ["Changed heading and subheading."],
    ops: [
      { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Stream heading ${Date.now()}` } },
      { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { subheading: `Stream subheading ${Date.now()}` } }
    ]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

  const response = await app.inject({
    method: "GET",
    url: `/chat/stream?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}&message=${encodeURIComponent("update hero copy")}`
  })
  assert.equal(response.statusCode, 200)

  const events = parseSseData(response.body)
  const opApplied = events.filter((event) => event.type === "op_applied")
  assert.equal(opApplied.length, mockedPlan.ops.length)
  const finalEvent = events.find((event) => event.type === "final")
  assert.ok(finalEvent)
  const result = (finalEvent as { result?: Record<string, unknown> }).result
  assert.ok(result)
  assert.equal(result?.status, "applied")
})

test("chat telemetry includes received -> plan_generated -> result phases for mocked planner run", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated heading for telemetry.",
    change_log: ["Changed heading."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Telemetry ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

  const chatResponse = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "update hero heading"
    }
  })
  assert.equal(chatResponse.statusCode, 200)

  const telemetryResponse = await app.inject({
    method: "GET",
    url: `/telemetry/chat?session=${encodeURIComponent(session)}&limit=50`
  })
  assert.equal(telemetryResponse.statusCode, 200)
  const telemetry = telemetryResponse.json() as {
    rows?: Array<{ phase?: string }>
  }
  const phases = new Set((telemetry.rows ?? []).map((row) => row.phase))
  assert.ok(phases.has("received"))
  assert.ok(phases.has("plan_generated"))
  assert.ok(phases.has("result"))
})

test("chat discard_pending_plan returns canceled when no pending plan exists", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "discard_pending_plan"
    }
  })
  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "canceled")
  assert.match(String(payload.summary), /No pending plan to stop/i)
})

test("chat pending-plan lifecycle: mismatch ids for discard/apply return 409", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const mockedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Ready plan for mismatch checks.",
    change_log: ["Prepared heading update."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: `Mismatch ${Date.now()}` } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: mockedPlan, usage: { ...ZERO_USAGE } }))

  const planReady = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading",
      executionMode: "plan_only"
    }
  })
  assert.equal(planReady.statusCode, 200)
  const planPayload = planReady.json() as { pendingPlanId?: string }
  assert.equal(typeof planPayload.pendingPlanId, "string")
  assert.ok(planPayload.pendingPlanId)

  const badApply = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan",
      pendingPlanId: "wrong-pending-id"
    }
  })
  assert.equal(badApply.statusCode, 409)
  const applyPayload = badApply.json() as { status?: string; summary?: string }
  assert.equal(applyPayload.status, "validation_error")
  assert.match(String(applyPayload.summary), /does not match/i)

  const badDiscard = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "discard_pending_plan",
      pendingPlanId: "wrong-pending-id"
    }
  })
  assert.equal(badDiscard.statusCode, 409)
  const discardPayload = badDiscard.json() as { error?: string }
  assert.match(String(discardPayload.error), /pending plan mismatch/i)
})

test("chat returns planning_exhausted after three failed OpenAI planning attempts", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  let attempts = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    attempts += 1
    throw new Error("invalid planner payload")
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "update hero heading in a safer way"
    }
  })

  assert.equal(response.statusCode, 500)
  assert.equal(attempts, 3)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; validationErrors?: string[] }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planning_exhausted")
  assert.ok(Array.isArray(payload.validationErrors))
  assert.equal(payload.validationErrors?.length, 3)
})

test("chat returns repair_failed when deterministic repair generation throws", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Try unsupported hero field.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
      }
    ]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    if (calls === 1) return { plan: invalidPlan, usage: { ...ZERO_USAGE } }
    throw new Error("invalid repair response")
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(calls, 2)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; validationErrors?: string[] }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.outcome, "repair_failed")
  assert.ok(Array.isArray(payload.validationErrors))
  assert.match(String(payload.validationErrors?.[0]), /schema_violation/i)
})

test("chat apply_pending_plan without pending plan and no message returns pending_plan_missing", async () => {
  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      executionMode: "apply_pending_plan"
    }
  })

  assert.equal(response.statusCode, 409)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; summary?: string }
  assert.equal(payload.status, "needs_clarification")
  assert.equal(payload.debug?.outcome, "pending_plan_missing")
  assert.match(String(payload.summary), /No pending plan/i)
})

test("chat applies repaired OpenAI plan after initial schema violation", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
      }
    ]
  }
  const repairedHeading = `Repaired heading ${Date.now()}`
  const repairedPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated hero heading after repair.",
    change_log: ["Applied repaired heading update."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: repairedHeading } }]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    return { plan: calls === 1 ? invalidPlan : repairedPlan, usage: { ...ZERO_USAGE } }
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls, 2)
  const payload = response.json() as { status?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /after repair/i)
})

test("chat returns guardrail failure when repaired plan still fails to apply", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid first attempt.",
    change_log: ["Attempted invalid patch."],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { notARealHeroProp: "x" } as Record<string, unknown>
      }
    ]
  }
  const stillBadRepairPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Still invalid after repair.",
    change_log: ["Attempted patch on missing block."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "missing_block", patch: { heading: "x" } }]
  }
  setGeneratePlanWithOpenAIForTests(async ({ feedback }) => ({ plan: feedback ? stillBadRepairPlan : invalidPlan, usage: { ...ZERO_USAGE } }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  const payload = response.json() as { status?: string; debug?: { reasonCategory?: string } }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.reasonCategory, "not_found")
})

test("chat returns planning_missing when planner returns null plan", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: null as unknown as EditPlan, usage: { ...ZERO_USAGE } }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 500)
  const payload = response.json() as { status?: string; debug?: { outcome?: string } }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planning_missing")
})

test("chat returns direct guardrail failure when initial apply error is not repair-eligible", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"
  const invalidPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Invalid not-found plan.",
    change_log: ["Attempted update on missing block."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "missing_block", patch: { heading: "x" } }]
  }
  let calls = 0
  setGeneratePlanWithOpenAIForTests(async () => {
    calls += 1
    return { plan: invalidPlan, usage: { ...ZERO_USAGE } }
  })
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "change hero heading"
    }
  })

  assert.equal(response.statusCode, 400)
  assert.equal(calls, 1)
  const payload = response.json() as { status?: string; debug?: { reasonCategory?: string } }
  assert.equal(payload.status, "validation_error")
  assert.equal(payload.debug?.reasonCategory, "not_found")
})

test("chat returns no_effective_change when plan updates a prop to its current value", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = previousKey || "test-key"

  const session = newSession()
  const pageRes = await app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent("/")}`
  })
  assert.equal(pageRes.statusCode, 200)
  const page = pageRes.json() as { blocks: Array<{ id: string; props: Record<string, unknown> }> }
  const hero = page.blocks.find((block) => block.id === "b_hero_home")
  assert.ok(hero)
  const currentHeading = String(hero?.props.heading ?? "")
  assert.ok(currentHeading.length > 0)

  const noOpPlan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "No-op heading update.",
    change_log: ["Tried to set heading to the same value."],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: currentHeading } }]
  }
  setGeneratePlanWithOpenAIForTests(async () => ({ plan: noOpPlan, usage: { ...ZERO_USAGE } }))
  t.after(() => {
    setGeneratePlanWithOpenAIForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "set hero heading to the same text"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; summary?: string; debug?: { outcome?: string } }
  assert.equal(payload.status, "applied")
  assert.match(String(payload.summary), /already up to date/i)
  assert.equal(payload.debug?.outcome, "no_effective_change")
})

test("chat uses demo planner path when OPENAI_API_KEY is missing", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "add testimonials"
    }
  })

  assert.equal(response.statusCode, 200)
  const payload = response.json() as { status?: string; plannerSource?: string; summary?: string }
  assert.equal(payload.status, "applied")
  assert.equal(payload.plannerSource, "demo")
  assert.match(String(payload.summary), /testimonials/i)
})

test("chat returns planner_exception when demo planner throws", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  setDemoPlanFromMessageForTests(() => {
    throw new Error("demo planner exploded")
  })
  t.after(() => {
    setDemoPlanFromMessageForTests()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
  })

  const session = newSession()
  const response = await app.inject({
    method: "POST",
    url: "/chat",
    headers: { "content-type": "application/json" },
    payload: {
      session,
      slug: "/",
      message: "anything"
    }
  })

  assert.equal(response.statusCode, 500)
  const payload = response.json() as { status?: string; debug?: { outcome?: string }; plannerSource?: string }
  assert.equal(payload.status, "error")
  assert.equal(payload.debug?.outcome, "planner_exception")
  assert.equal(payload.plannerSource, "demo")
})
