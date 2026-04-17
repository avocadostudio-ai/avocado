import test from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@ai-site-editor/shared"
import { createPlannerRegistry, type Planner, type GeneratePlanResult } from "./planner-types.js"
import { resolvePlannerSource, type PlannerSource } from "./provider-routing.js"
import { ZERO_USAGE } from "../telemetry/usage.js"

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function withApiKeys(
  args: { openai?: string; anthropic?: string; gemini?: string },
  fn: () => void
) {
  const prev = {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GOOGLE_GENAI_API_KEY,
  }
  const set = (k: string, v?: string) => {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  set("OPENAI_API_KEY", args.openai)
  set("ANTHROPIC_API_KEY", args.anthropic)
  set("GOOGLE_GENAI_API_KEY", args.gemini)
  try {
    fn()
  } finally {
    set("OPENAI_API_KEY", prev.openai)
    set("ANTHROPIC_API_KEY", prev.anthropic)
    set("GOOGLE_GENAI_API_KEY", prev.gemini)
  }
}

// ---------------------------------------------------------------------------
// Fake planner factory
// ---------------------------------------------------------------------------

type CallLog = {
  parseIntent: Array<{ source: PlannerSource; model: string }>
  generatePlan: Array<{ source: PlannerSource; model: string }>
}

function fakePlanner(source: PlannerSource, log: CallLog): Planner {
  return {
    source,
    supportsNativeTools: source !== "openai",
    async parseIntent(args) {
      log.parseIntent.push({ source, model: args.model })
      return {
        action: "edit",
        complexity: "simple",
      } as never
    },
    async generatePlan(args) {
      log.generatePlan.push({ source, model: args.model })
      const result: GeneratePlanResult = {
        plan: {
          intent: "edit_plan",
          ops: [],
          summary_for_user: `fake:${source}`,
        } as never,
        usage: ZERO_USAGE,
        schemaContext: {} as never,
      }
      return result
    },
  }
}

const emptyPage = {
  id: "p1",
  title: "",
  slug: "/",
  blocks: [],
  meta: {},
} as unknown as PageDoc

// ---------------------------------------------------------------------------
// Tests — registry dispatch
// ---------------------------------------------------------------------------

test("registry returns default planner for each known source", () => {
  const registry = createPlannerRegistry()
  for (const source of ["openai", "anthropic", "gemini"] as const) {
    const planner = registry.get(source)
    assert.ok(planner, `expected planner for ${source}`)
    assert.equal(planner!.source, source)
  }
})

test("registry returns null for 'demo' source (demo is not an LLM planner)", () => {
  const registry = createPlannerRegistry()
  assert.equal(registry.get("demo"), null)
  assert.equal(registry.has("demo"), false)
})

test("registry overrides replace default planners without touching others", () => {
  const log: CallLog = { parseIntent: [], generatePlan: [] }
  const fakeOpenAI = fakePlanner("openai", log)
  const registry = createPlannerRegistry({ openai: fakeOpenAI })

  assert.equal(registry.get("openai"), fakeOpenAI)
  // Other providers remain the real default implementations.
  assert.notEqual(registry.get("anthropic"), fakeOpenAI)
  assert.equal(registry.get("anthropic")?.source, "anthropic")
  assert.equal(registry.get("gemini")?.source, "gemini")
})

test("dispatch: source → correct planner is invoked (parseIntent + generatePlan)", async () => {
  const log: CallLog = { parseIntent: [], generatePlan: [] }
  const registry = createPlannerRegistry({
    openai: fakePlanner("openai", log),
    anthropic: fakePlanner("anthropic", log),
    gemini: fakePlanner("gemini", log),
  })

  for (const source of ["openai", "anthropic", "gemini"] as const) {
    const planner = registry.get(source)!
    await planner.parseIntent({
      message: "hello",
      slug: "/",
      currentPage: emptyPage,
      model: `${source}-model`,
    })
    await planner.generatePlan({
      message: "hello",
      slug: "/",
      currentPage: emptyPage,
      contextPack: {} as never,
      model: `${source}-model`,
    })
  }

  assert.deepEqual(
    log.parseIntent.map((e) => e.source),
    ["openai", "anthropic", "gemini"]
  )
  assert.deepEqual(
    log.generatePlan.map((e) => e.source),
    ["openai", "anthropic", "gemini"]
  )
  // And the model param is passed through unchanged.
  assert.deepEqual(
    log.generatePlan.map((e) => e.model),
    ["openai-model", "anthropic-model", "gemini-model"]
  )
})

test("only the selected source's planner runs — others are not touched", async () => {
  const log: CallLog = { parseIntent: [], generatePlan: [] }
  const registry = createPlannerRegistry({
    openai: fakePlanner("openai", log),
    anthropic: fakePlanner("anthropic", log),
    gemini: fakePlanner("gemini", log),
  })

  const source: PlannerSource = "anthropic"
  const planner = registry.get(source)!
  await planner.generatePlan({
    message: "hello",
    slug: "/",
    currentPage: emptyPage,
    contextPack: {} as never,
    model: "claude-test",
  })

  assert.equal(log.generatePlan.length, 1)
  assert.equal(log.generatePlan[0]?.source, "anthropic")
  assert.equal(log.parseIntent.length, 0)
})

// ---------------------------------------------------------------------------
// Tests — source selection (locks current behavior)
// Asserts that `resolvePlannerSource` + registry combine to route correctly
// given env-key availability.
// ---------------------------------------------------------------------------

test("source selection: anthropic key only → anthropic planner", () => {
  withApiKeys({ anthropic: "a-key" }, () => {
    const source = resolvePlannerSource("openai") // user asked for openai
    const planner = createPlannerRegistry().get(source)
    assert.equal(source, "anthropic")
    assert.equal(planner?.source, "anthropic")
  })
})

test("source selection: openai key only → openai planner", () => {
  withApiKeys({ openai: "o-key" }, () => {
    const source = resolvePlannerSource("anthropic")
    const planner = createPlannerRegistry().get(source)
    assert.equal(source, "openai")
    assert.equal(planner?.source, "openai")
  })
})

test("source selection: gemini key only → gemini planner", () => {
  withApiKeys({ gemini: "g-key" }, () => {
    const source = resolvePlannerSource("openai")
    const planner = createPlannerRegistry().get(source)
    assert.equal(source, "gemini")
    assert.equal(planner?.source, "gemini")
  })
})

test("source selection: no keys → demo source, registry returns null", () => {
  withApiKeys({}, () => {
    const source = resolvePlannerSource("openai")
    assert.equal(source, "demo")
    assert.equal(createPlannerRegistry().get(source), null)
  })
})

test("source selection: all keys present, user requests openai → openai wins", () => {
  withApiKeys({ openai: "o", anthropic: "a", gemini: "g" }, () => {
    assert.equal(resolvePlannerSource("openai"), "openai")
    assert.equal(resolvePlannerSource("anthropic"), "anthropic")
    assert.equal(resolvePlannerSource("gemini"), "gemini")
  })
})
