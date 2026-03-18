import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { config } from "dotenv"
import type { EditPlan, PageDoc } from "@ai-site-editor/shared"
import type { TokenUsage } from "./telemetry/usage.js"

// Load .env so API keys are available
config()

// ---------------------------------------------------------------------------
// Fixture: realistic Tabs block (avocado-themed)
// ---------------------------------------------------------------------------
const tabsBlock = {
  id: "b_tabs_avocado",
  type: "Tabs" as const,
  props: {
    tabs: [
      { label: "Overview", content: "The avocado is a versatile fruit prized for its creamy texture and rich nutritional profile." },
      { label: "Recipes & Ideas", content: "## Quick Recipes\n\n- **Classic guacamole** — mash 2 ripe avocados with lime, cilantro, and salt\n- **Avocado toast** — sourdough, smashed avo, everything bagel seasoning" },
      { label: "Sustainability", content: "Avocado farming has both challenges and opportunities. Water usage in key growing regions like Michoacán remains a concern, but regenerative farming practices are gaining traction." },
      { label: "Fun Facts", content: "Did you know? The word 'avocado' comes from the Nahuatl word 'ahuacatl'. A single avocado tree can produce up to 500 avocados per year." },
      { label: "Selection & Storage Tips", content: "### How to Pick the Perfect Avocado\n\nGently press near the stem — if it yields slightly, it's ripe. Store unripe avocados at room temperature; refrigerate ripe ones to extend freshness by 2-3 days." }
    ]
  }
}

const testPage: PageDoc = {
  id: "test-page",
  slug: "/",
  title: "Avocado Guide",
  updatedAt: new Date().toISOString(),
  blocks: [tabsBlock]
}

// Minimal context pack — just enough for the planner to work
function buildTestContextPack(page: PageDoc, activeBlockId?: string) {
  return {
    route: page.slug,
    pageRoutes: [page.slug],
    blockCount: page.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockId ? page.blocks.find(b => b.id === activeBlockId)?.type ?? null : null,
      editablePath: null,
      block: activeBlockId
        ? {
            id: activeBlockId,
            type: page.blocks.find(b => b.id === activeBlockId)?.type ?? null,
            props: page.blocks.find(b => b.id === activeBlockId)?.props ?? {},
            selectedEditableValue: null
          }
        : null,
      imageUrlForVision: null
    },
    neighbors: { previous: null, next: null },
    pageOutline: page.blocks.map(b => ({
      id: b.id,
      type: b.type,
      props: b.props,
      arrayProps: Object.fromEntries(
        Object.entries(b.props)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, { length: (v as unknown[]).length }])
      )
    })),
    pageMeta: null,
    pageIntent: `Page with ${page.blocks.length} block(s)`,
    recentSuccessfulEdits: [],
    resolvedReferences: {
      target: null,
      anchor: null,
      mentionedBlocks: []
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assertValidUpdatePropsPlan(plan: EditPlan, expectedBlockId: string) {
  assert.equal(plan.intent, "edit_plan", `Expected edit_plan, got ${plan.intent}`)
  assert.ok(plan.ops.length >= 1, `Expected at least 1 op, got ${plan.ops.length}`)
  const op = plan.ops[0]
  assert.equal(op.op, "update_props", `Expected update_props, got ${op.op}`)
  assert.equal(op.blockId, expectedBlockId, `Expected blockId ${expectedBlockId}, got ${op.blockId}`)
  assert.ok("patch" in op && op.patch, "Expected patch to exist")
}

// ---------------------------------------------------------------------------
// OpenAI E2E tests
// ---------------------------------------------------------------------------
describe("planner-e2e: OpenAI gpt-4o-mini", { timeout: 30_000 }, () => {
  const hasKey = !!process.env.OPENAI_API_KEY

  before(() => {
    if (!hasKey) {
      console.log("⏭  Skipping OpenAI E2E tests — OPENAI_API_KEY not set")
    }
  })

  it("generates valid update_props plan for 'add emojis to tab labels'", { skip: !hasKey }, async () => {
    // Dynamic import to avoid module-level API key errors
    const { generatePlanWithOpenAI } = await import("./chat/planner.js")

    const contextPack = buildTestContextPack(testPage, "b_tabs_avocado")
    const start = performance.now()

    const result = await generatePlanWithOpenAI({
      message: "add emojis to tab labels",
      slug: "/",
      currentPage: testPage,
      contextPack: contextPack as ReturnType<typeof import("./nlp/deterministic-planner.js").plannerContextPack>,
      model: "gpt-4o-mini",
      lightweight: true
    })

    const latencyMs = performance.now() - start
    console.log(`  OpenAI gpt-4o-mini "add emojis" — ${latencyMs.toFixed(0)}ms, tokens: ${JSON.stringify(result.usage)}`)

    assertValidUpdatePropsPlan(result.plan, "b_tabs_avocado")
    const patch = (result.plan.ops[0] as { patch: Record<string, unknown> }).patch
    assert.ok(patch.tabs, "Expected tabs in patch")
    const tabs = patch.tabs as Array<{ label: string }>
    assert.equal(tabs.length, 5, `Expected 5 tabs, got ${tabs.length}`)
    // Each label should contain at least one emoji character (outside basic ASCII)
    for (const tab of tabs) {
      assert.ok(
        // eslint-disable-next-line no-control-regex
        /[^\x00-\x7F]/.test(tab.label),
        `Expected emoji in label "${tab.label}"`
      )
    }
  })

  it("generates valid update_props plan for 'remove emojis from tab labels'", { skip: !hasKey }, async () => {
    const { generatePlanWithOpenAI } = await import("./chat/planner.js")

    // Start with emoji labels
    const emojiPage: PageDoc = {
      ...testPage,
      blocks: [{
        ...tabsBlock,
        props: {
          tabs: [
            { label: "🥑 Overview", content: tabsBlock.props.tabs[0].content },
            { label: "🍽️ Recipes & Ideas", content: tabsBlock.props.tabs[1].content },
            { label: "🌱 Sustainability", content: tabsBlock.props.tabs[2].content },
            { label: "🎉 Fun Facts", content: tabsBlock.props.tabs[3].content },
            { label: "📦 Selection & Storage Tips", content: tabsBlock.props.tabs[4].content }
          ]
        }
      }]
    }
    const contextPack = buildTestContextPack(emojiPage, "b_tabs_avocado")
    const start = performance.now()

    const result = await generatePlanWithOpenAI({
      message: "remove emojis from tab labels",
      slug: "/",
      currentPage: emojiPage,
      contextPack: contextPack as ReturnType<typeof import("./nlp/deterministic-planner.js").plannerContextPack>,
      model: "gpt-4o-mini",
      lightweight: true
    })

    const latencyMs = performance.now() - start
    console.log(`  OpenAI gpt-4o-mini "remove emojis" — ${latencyMs.toFixed(0)}ms, tokens: ${JSON.stringify(result.usage)}`)

    assertValidUpdatePropsPlan(result.plan, "b_tabs_avocado")
    const patch = (result.plan.ops[0] as { patch: Record<string, unknown> }).patch
    assert.ok(patch.tabs, "Expected tabs in patch")
    const tabs = patch.tabs as Array<{ label: string }>
    assert.equal(tabs.length, 5, `Expected 5 tabs, got ${tabs.length}`)
    for (const tab of tabs) {
      // Labels should be clean ASCII (no emoji)
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u{1F000}-\u{1FFFF}]/u.test(tab.label), `Expected no emoji in label "${tab.label}"`)
    }
  })
})

// ---------------------------------------------------------------------------
// Anthropic E2E tests
// ---------------------------------------------------------------------------
describe("planner-e2e: Anthropic claude-haiku", { timeout: 30_000 }, () => {
  const hasKey = !!process.env.ANTHROPIC_API_KEY

  before(() => {
    if (!hasKey) {
      console.log("⏭  Skipping Anthropic E2E tests — ANTHROPIC_API_KEY not set")
    }
  })

  it("generates valid update_props plan for 'add emojis to tab labels'", { skip: !hasKey }, async () => {
    const { generatePlanWithAnthropic } = await import("./chat/anthropic-planner.js")

    const contextPack = buildTestContextPack(testPage, "b_tabs_avocado")
    const start = performance.now()

    const result = await generatePlanWithAnthropic({
      message: "add emojis to tab labels",
      slug: "/",
      currentPage: testPage,
      contextPack: contextPack as ReturnType<typeof import("./nlp/deterministic-planner.js").plannerContextPack>,
      model: process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-4-5-20251001",
      lightweight: true,
      onToken: () => {} // use streaming tool path (matches real pipeline)
    })

    const latencyMs = performance.now() - start
    console.log(`  Anthropic haiku "add emojis" — ${latencyMs.toFixed(0)}ms, tokens: ${JSON.stringify(result.usage)}`)

    assertValidUpdatePropsPlan(result.plan, "b_tabs_avocado")
    const patch = (result.plan.ops[0] as { patch: Record<string, unknown> }).patch
    assert.ok(patch.tabs, "Expected tabs in patch")
    const tabs = patch.tabs as Array<{ label: string }>
    assert.equal(tabs.length, 5, `Expected 5 tabs, got ${tabs.length}`)
    for (const tab of tabs) {
      assert.ok(
        // eslint-disable-next-line no-control-regex
        /[^\x00-\x7F]/.test(tab.label),
        `Expected emoji in label "${tab.label}"`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Create page with multiple blocks — tests the full LLM path
// ---------------------------------------------------------------------------
describe("planner-e2e: create_page with enumerated blocks", { timeout: 60_000 }, () => {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY
  const hasAnyKey = hasOpenAIKey || hasAnthropicKey

  // Minimal single-block page to serve as "current page"
  const minimalPage: PageDoc = {
    id: "home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [{
      id: "b_hero_home",
      type: "Hero" as const,
      props: { heading: "Welcome", subheading: "A test site" }
    }]
  }

  before(() => {
    if (!hasAnyKey) console.log("⏭  Skipping create_page E2E tests — no API keys")
  })

  it("generates create_page with multiple blocks for topic landing page", { skip: !hasAnyKey }, async () => {
    const provider = hasAnthropicKey ? "anthropic" : "openai"
    const contextPack = buildTestContextPack(minimalPage)

    const message = "Create a new page about avocado recipes with a Hero section, a feature highlights grid with cooking benefits, a card grid showcasing 3 signature recipes, a rich text section with preparation tips, an FAQ section answering common cooking questions, and a CTA inviting visitors to submit recipes. Fill all sections with realistic content — no placeholders."

    const start = performance.now()
    let result: { plan: EditPlan; usage: TokenUsage }

    if (provider === "anthropic") {
      const { generatePlanWithAnthropic } = await import("./chat/anthropic-planner.js")
      result = await generatePlanWithAnthropic({
        message,
        slug: "/",
        currentPage: minimalPage,
        contextPack: contextPack as ReturnType<typeof import("./nlp/deterministic-planner.js").plannerContextPack>,
        model: process.env.ANTHROPIC_MODEL_BALANCED ?? "claude-sonnet-4-5-20250514",
        onToken: () => {}
      })
    } else {
      const { generatePlanWithOpenAI } = await import("./chat/planner.js")
      result = await generatePlanWithOpenAI({
        message,
        slug: "/",
        currentPage: minimalPage,
        contextPack: contextPack as ReturnType<typeof import("./nlp/deterministic-planner.js").plannerContextPack>,
        model: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o"
      })
    }

    const latencyMs = performance.now() - start
    const { plan } = result
    console.log(`  ${provider} create_page — ${latencyMs.toFixed(0)}ms, tokens: ${JSON.stringify(result.usage)}`)
    console.log(`  intent: ${plan.intent}, ops: ${plan.ops.length}, types: ${plan.ops.map(o => o.op).join(", ")}`)

    assert.equal(plan.intent, "edit_plan", `Expected edit_plan, got ${plan.intent}`)
    assert.ok(plan.ops.length >= 1, `Expected at least 1 op`)

    // Should be a create_page with multiple blocks inside, OR multiple add_block ops
    const createOp = plan.ops.find(o => o.op === "create_page")
    const addOps = plan.ops.filter(o => o.op === "add_block")

    if (createOp && "page" in createOp) {
      const page = createOp.page as PageDoc
      const totalBlocks = page.blocks.length + addOps.length
      console.log(`  create_page slug: ${page.slug}, inline blocks: ${page.blocks.length}, add_block ops: ${addOps.length}`)
      console.log(`  block types: ${[...page.blocks.map(b => b.type), ...addOps.map(o => ("block" in o ? (o.block as { type: string }).type : "?"))].join(", ")}`)

      // Slug should be clean — "avocado-recipes", not the whole prompt
      assert.ok(
        !page.slug.includes("hero") && !page.slug.includes("section"),
        `Slug should not contain block type words: ${page.slug}`
      )
      // Total blocks (inline + add_block ops) should be at least 4
      assert.ok(totalBlocks >= 4, `Expected ≥4 total blocks, got ${totalBlocks} (${page.blocks.length} inline + ${addOps.length} add_block)`)
    } else if (addOps.length > 0) {
      console.log(`  ${addOps.length} add_block ops`)
      assert.ok(addOps.length >= 4, `Expected ≥4 add_block ops, got ${addOps.length}`)
    } else {
      assert.fail(`Expected create_page or multiple add_block ops, got: ${plan.ops.map(o => o.op).join(", ")}`)
    }
  })
})
