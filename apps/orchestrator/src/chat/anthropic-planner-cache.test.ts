import test from "node:test"
import assert from "node:assert/strict"
import type Anthropic from "@anthropic-ai/sdk"
import type { PageDoc } from "@ai-site-editor/shared"
import { generatePlanWithAnthropic, type PlannerAnthropicClient } from "./anthropic-planner.js"
import { plannerContextPack } from "../nlp/deterministic-planner.js"

// ---------------------------------------------------------------------------
// Tests for prompt-cache structural invariants on the Anthropic planner.
//
// Anthropic prompt caching matches the cached prefix byte-for-byte. If
// per-request flags (selected block id, conditional modes, locale, …) are
// woven into the same `cache_control` block, every request with a different
// flag misses the cache and re-pays the write cost.
//
// generatePlanWithAnthropic must therefore split the system prompt into:
//   • a *stable* prefix (provider rules) carrying `cache_control`
//   • a *dynamic* suffix (per-request flags) without `cache_control`
//
// And the large editPlanJsonSchema-bearing tool (submit_edit_plan) must
// always carry `cache_control` so runtime-tool churn does not bust it.
// ---------------------------------------------------------------------------

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function makePage(): PageDoc {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero_alpha",
        type: "Hero",
        props: { heading: "A", subheading: "S", imageUrl: "/x.svg", imageAlt: "x" }
      },
      {
        id: "b_hero_bravo",
        type: "Hero",
        props: { heading: "B", subheading: "T", imageUrl: "/y.svg", imageAlt: "y" }
      }
    ]
  }
}

function makeContextPack(blockId: string): ReturnType<typeof plannerContextPack> {
  return {
    route: "/",
    pageRoutes: ["/"],
    selected: { blockId, editablePath: "heading", block: null },
    neighbors: { previous: null, next: null },
    pageOutline: [
      { id: "b_hero_alpha", type: "Hero", props: { heading: "A" }, arrayProps: [] },
      { id: "b_hero_bravo", type: "Hero", props: { heading: "B" }, arrayProps: [] }
    ],
    resolvedReferences: { target: null, anchor: null, mentionedBlocks: [] },
    recentSuccessfulEdits: []
  } as unknown as ReturnType<typeof plannerContextPack>
}

type CapturedRequest = {
  system?: unknown
  tools?: unknown[]
}

function makeCapturingClient(captured: CapturedRequest[]): PlannerAnthropicClient {
  // Mock that satisfies whichever no-tools path the planner takes:
  //   • output_config path → return text JSON
  //   • tool_choice path   → return tool_use block
  return {
    messages: {
      create: async (args: unknown) => {
        captured.push(args as CapturedRequest)
        const plan = {
          intent: "edit_plan",
          summary_for_user: "ok",
          change_log: [],
          ops: [],
          suggested_next_actions: []
        }
        const a = args as { output_config?: unknown; tools?: unknown[] }
        if (a.output_config) {
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(plan) }],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          } as unknown as Anthropic.Messages.Message
        }
        return {
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "toolu_x", name: "submit_edit_plan", input: plan }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        } as unknown as Anthropic.Messages.Message
      }
    }
  }
}

function findPlannerCall(captured: CapturedRequest[]): CapturedRequest {
  // Return the first request that carries the submit_edit_plan tool — that's
  // the one whose tool cache_control we want to inspect. Both no-tools paths
  // (output_config and tool_choice fallback) are valid, but output_config has
  // no tools field so we look for the tool_choice path explicitly when needed.
  const withTools = captured.find((c) => Array.isArray(c.tools) && c.tools.length > 0)
  return withTools ?? captured[0]!
}

test("planner system prompt is split: stable prefix carries cache_control, dynamic tail does not", async () => {
  await withEnv({ ANTHROPIC_PROMPT_CACHE: "1", ANTHROPIC_PROMPT_CACHE_TTL: "1h" }, async () => {
    const captured: CapturedRequest[] = []
    const client = makeCapturingClient(captured)

    await generatePlanWithAnthropic({
      message: "rewrite hero heading",
      slug: "/",
      currentPage: makePage(),
      contextPack: makeContextPack("b_hero_alpha"),
      model: "claude-sonnet-4-6",
      client
    })

    assert.ok(captured.length >= 1)
    // Every captured call must have the same segmented system shape — the
    // planner may call messages.create multiple times (output_config probe +
    // tool_choice fallback), but all of them share the cachedSystem value.
    for (const call of captured) {
      const system = call.system
      assert.ok(Array.isArray(system), "system field should be a TextBlockParam[] when caching is enabled")
      assert.equal(system.length, 2, "system should have exactly two blocks: stable + dynamic")
      const [stable, dynamic] = system as Anthropic.TextBlockParam[]
      assert.equal(stable.type, "text")
      assert.deepEqual(stable.cache_control, { type: "ephemeral", ttl: "1h" }, "stable prefix must carry cache_control")
      assert.equal(dynamic.type, "text")
      assert.equal(dynamic.cache_control, undefined, "dynamic suffix must NOT carry cache_control")
      assert.ok(stable.text.length > 200, "stable prefix should contain the bulk of the system prompt")
      assert.ok(dynamic.text.includes("b_hero_alpha"), "dynamic suffix should contain the per-request selected block id")
      assert.ok(!stable.text.includes("b_hero_alpha"), "stable prefix must NOT mention per-request selected block id")
    }
  })
})

test("planner stable prefix is byte-identical across requests with different selectedBlockId", async () => {
  await withEnv({ ANTHROPIC_PROMPT_CACHE: "1", ANTHROPIC_PROMPT_CACHE_TTL: "1h" }, async () => {
    const captured: CapturedRequest[] = []
    const client = makeCapturingClient(captured)

    for (const blockId of ["b_hero_alpha", "b_hero_bravo"]) {
      await generatePlanWithAnthropic({
        message: "rewrite hero heading",
        slug: "/",
        currentPage: makePage(),
        contextPack: makeContextPack(blockId),
        model: "claude-sonnet-4-6",
        client
      })
    }

    // Find the first request from each invocation by looking for transitions
    // in the dynamic-suffix blockId. A single invocation may produce multiple
    // captured calls (output_config + fallback), but they share the same
    // cachedSystem, so we just compare the first call from each invocation.
    const callsByBlockId = new Map<string, Anthropic.TextBlockParam[]>()
    for (const call of captured) {
      const sys = call.system as Anthropic.TextBlockParam[]
      const dynamic = sys[1]!.text
      const blockId = dynamic.includes("b_hero_alpha") ? "b_hero_alpha" : "b_hero_bravo"
      if (!callsByBlockId.has(blockId)) callsByBlockId.set(blockId, sys)
    }
    assert.equal(callsByBlockId.size, 2, "should see calls for both block ids")

    const sysAlpha = callsByBlockId.get("b_hero_alpha")!
    const sysBravo = callsByBlockId.get("b_hero_bravo")!
    assert.equal(sysAlpha[0]!.text, sysBravo[0]!.text, "stable prefix must be byte-identical → cache hit on second call")
    assert.notEqual(sysAlpha[1]!.text, sysBravo[1]!.text, "dynamic suffix must differ when selectedBlockId changes")
    assert.ok(sysAlpha[1]!.text.includes("b_hero_alpha"))
    assert.ok(sysBravo[1]!.text.includes("b_hero_bravo"))
  })
})

test("submit_edit_plan tool carries cache_control (covers large editPlanJsonSchema)", async () => {
  await withEnv({ ANTHROPIC_PROMPT_CACHE: "1", ANTHROPIC_PROMPT_CACHE_TTL: "1h" }, async () => {
    const captured: CapturedRequest[] = []
    const client = makeCapturingClient(captured)

    // thinking: { ... } forces the tool_choice path (output_config is skipped
    // when extended thinking is requested) so the captured call carries tools.
    await generatePlanWithAnthropic({
      message: "rewrite hero heading",
      slug: "/",
      currentPage: makePage(),
      contextPack: makeContextPack("b_hero_alpha"),
      model: "claude-sonnet-4-6",
      thinking: { budgetTokens: 1024 },
      client
    })

    const callWithTools = findPlannerCall(captured)
    const tools = callWithTools.tools as Array<Anthropic.Messages.Tool & { cache_control?: unknown }>
    assert.ok(Array.isArray(tools) && tools.length >= 1, "expected a captured call carrying tools")
    const submit = tools.find((t) => t.name === "submit_edit_plan")
    assert.ok(submit, "submit_edit_plan tool must be present")
    assert.deepEqual(submit.cache_control, { type: "ephemeral", ttl: "1h" }, "submit_edit_plan must carry cache_control")
  })
})

test("planner falls back to single string system when prompt caching is disabled", async () => {
  await withEnv({ ANTHROPIC_PROMPT_CACHE: undefined, ANTHROPIC_PROMPT_CACHE_TTL: undefined }, async () => {
    const captured: CapturedRequest[] = []
    const client = makeCapturingClient(captured)

    await generatePlanWithAnthropic({
      message: "rewrite hero heading",
      slug: "/",
      currentPage: makePage(),
      contextPack: makeContextPack("b_hero_alpha"),
      model: "claude-sonnet-4-6",
      client
    })

    for (const call of captured) {
      assert.equal(typeof call.system, "string", "system should be a plain string when caching is disabled")
    }
    const callWithTools = findPlannerCall(captured)
    const tools = callWithTools.tools as Array<Anthropic.Messages.Tool & { cache_control?: unknown }> | undefined
    if (tools) {
      const submit = tools.find((t) => t.name === "submit_edit_plan")
      assert.equal(submit?.cache_control, undefined, "submit_edit_plan must NOT carry cache_control when caching is disabled")
    }
  })
})
