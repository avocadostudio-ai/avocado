import test from "node:test"
import assert from "node:assert/strict"
import {
  shouldPreferFastModelForMessage,
  shouldUseLlmIntentRouter,
  compactPlannerContextPack,
  minimalPlannerContextPack,
  shouldUseMinimalPlannerContext,
  shouldPreferFocusedTranslation,
  classifyMessageComplexity,
  isRouterPlanTooShallow
} from "./chat-pipeline-context.js"
import type { EditPlan, PageDoc } from "@ai-site-editor/shared"

// ---------------------------------------------------------------------------
// shouldPreferFastModelForMessage
// ---------------------------------------------------------------------------

test("shouldPreferFastModelForMessage: true for rewrite-like messages", () => {
  assert.ok(shouldPreferFastModelForMessage("rewrite the heading"))
  assert.ok(shouldPreferFastModelForMessage("polish the copy"))
  assert.ok(shouldPreferFastModelForMessage("tighten the messaging"))
})

test("shouldPreferFastModelForMessage: true for simple prop edits", () => {
  assert.ok(shouldPreferFastModelForMessage("change the title"))
  assert.ok(shouldPreferFastModelForMessage("update the heading text"))
  assert.ok(shouldPreferFastModelForMessage("remove the emoji from the label"))
  assert.ok(shouldPreferFastModelForMessage("add icons to the features"))
  assert.ok(shouldPreferFastModelForMessage("set the link text"))
})

test("shouldPreferFastModelForMessage: false for translations", () => {
  assert.ok(!shouldPreferFastModelForMessage("translate to German"))
  assert.ok(!shouldPreferFastModelForMessage("localize the page to Spanish"))
})

test("shouldPreferFastModelForMessage: false for page operations", () => {
  assert.ok(!shouldPreferFastModelForMessage("create a new page called About"))
  assert.ok(!shouldPreferFastModelForMessage("duplicate the page"))
})

test("shouldPreferFastModelForMessage: false for clarification follow-ups", () => {
  const msg = "Describe the logical order you'd like blocks reordered to\nClarification from user: Apply the recommended reordering"
  assert.ok(!shouldPreferFastModelForMessage(msg))
})

test("shouldPreferFastModelForMessage: false for complex content requests", () => {
  assert.ok(!shouldPreferFastModelForMessage("generate a pricing section with three tiers"))
  assert.ok(!shouldPreferFastModelForMessage("build a testimonials section"))
})

// ---------------------------------------------------------------------------
// shouldUseLlmIntentRouter
// ---------------------------------------------------------------------------

test("shouldUseLlmIntentRouter: true for edit-like messages", () => {
  assert.ok(shouldUseLlmIntentRouter("replace the heading with something better"))
  assert.ok(shouldUseLlmIntentRouter("change the CTA text"))
  assert.ok(shouldUseLlmIntentRouter("rewrite the hero copy"))
  assert.ok(shouldUseLlmIntentRouter("delete the FAQ section"))
  assert.ok(shouldUseLlmIntentRouter("move the CTA up"))
  assert.ok(shouldUseLlmIntentRouter("add a testimonials block"))
})

test("shouldUseLlmIntentRouter: false for clarification follow-ups", () => {
  const msg = "reorder blocks on this page\nClarification from user: move banner to top"
  assert.ok(!shouldUseLlmIntentRouter(msg))
})

test("shouldUseLlmIntentRouter: false for empty messages", () => {
  assert.ok(!shouldUseLlmIntentRouter(""))
  assert.ok(!shouldUseLlmIntentRouter("   "))
})

test("shouldUseLlmIntentRouter: false for very long messages (>260 chars)", () => {
  const long = "a".repeat(261)
  assert.ok(!shouldUseLlmIntentRouter(long))
})

test("shouldUseLlmIntentRouter: false for translations", () => {
  assert.ok(!shouldUseLlmIntentRouter("translate to German"))
})

test("shouldUseLlmIntentRouter: false for page operations", () => {
  assert.ok(!shouldUseLlmIntentRouter("create a new page"))
})

// ---------------------------------------------------------------------------
// compactPlannerContextPack
// ---------------------------------------------------------------------------

function makeContextPack(selectedBlockId: string) {
  return {
    route: "/",
    pageRoutes: ["/", "/pricing", "/about"],
    selected: { blockId: selectedBlockId, editablePath: null },
    neighbors: { previous: null, next: null },
    pageOutline: [
      { id: "b_hero", type: "Hero", props: { heading: "Hello", subheading: "World" }, arrayProps: {} },
      { id: "b_grid", type: "FeatureGrid", props: { title: "Features" }, arrayProps: { features: 3 } },
      { id: "b_cta", type: "CTA", props: { title: "Ready" }, arrayProps: {} }
    ],
    recentSuccessfulEdits: [
      { at: "1", summary: "Edit 1", ops: ["update_props"] },
      { at: "2", summary: "Edit 2", ops: ["update_props"] },
      { at: "3", summary: "Edit 3", ops: ["add_block"] },
      { at: "4", summary: "Edit 4", ops: ["remove_block"] }
    ],
    resolvedReferences: { target: null, anchor: null, mentionedBlocks: [] }
  } as ReturnType<typeof compactPlannerContextPack> extends { contextPack: infer T } ? T : any
}

test("compactPlannerContextPack: strips props from non-selected blocks", () => {
  const pack = makeContextPack("b_hero")
  const result = compactPlannerContextPack({
    contextPack: pack,
    message: "change the heading",
    translationScope: "none"
  })
  // Selected block keeps full props
  const hero = result.pageOutline.find((e: any) => e.id === "b_hero")!
  assert.deepEqual(hero.props, { heading: "Hello", subheading: "World" })
  // Non-selected blocks get empty props
  const grid = result.pageOutline.find((e: any) => e.id === "b_grid")!
  assert.deepEqual(grid.props, {})
  // arrayProps preserved
  assert.deepEqual(grid.arrayProps, { features: 3 })
})

test("compactPlannerContextPack: trims recentSuccessfulEdits to 3", () => {
  const pack = makeContextPack("b_hero")
  const result = compactPlannerContextPack({
    contextPack: pack,
    message: "change the heading",
    translationScope: "none"
  })
  assert.equal(result.recentSuccessfulEdits.length, 3)
})

test("compactPlannerContextPack: keeps full context for page-scope translations", () => {
  const pack = makeContextPack("b_hero")
  const result = compactPlannerContextPack({
    contextPack: pack,
    message: "translate the page to German",
    translationScope: "page"
  })
  // All blocks keep props
  const grid = result.pageOutline.find((e: any) => e.id === "b_grid")!
  assert.deepEqual(grid.props, { title: "Features" })
})

test("compactPlannerContextPack: keeps full context for create page requests", () => {
  const pack = makeContextPack("b_hero")
  const result = compactPlannerContextPack({
    contextPack: pack,
    message: "create a new page called About",
    translationScope: "none"
  })
  const grid = result.pageOutline.find((e: any) => e.id === "b_grid")!
  assert.deepEqual(grid.props, { title: "Features" })
})

// ---------------------------------------------------------------------------
// minimalPlannerContextPack
// ---------------------------------------------------------------------------

test("minimalPlannerContextPack: retains only selected + neighbors", () => {
  const pack = makeContextPack("b_grid")
  pack.neighbors = {
    previous: { id: "b_hero", type: "Hero" },
    next: { id: "b_cta", type: "CTA" }
  }
  const result = minimalPlannerContextPack({ contextPack: pack })
  assert.equal(result.pageOutline.length, 3)
  assert.ok(result.pageOutline.some((e: any) => e.id === "b_hero"))
  assert.ok(result.pageOutline.some((e: any) => e.id === "b_grid"))
  assert.ok(result.pageOutline.some((e: any) => e.id === "b_cta"))
})

test("minimalPlannerContextPack: selected block keeps full props", () => {
  const pack = makeContextPack("b_grid")
  pack.neighbors = { previous: { id: "b_hero", type: "Hero" }, next: null }
  const result = minimalPlannerContextPack({ contextPack: pack })
  const grid = result.pageOutline.find((e: any) => e.id === "b_grid")!
  assert.deepEqual(grid.props, { title: "Features" })
  // Neighbor gets stripped props
  const hero = result.pageOutline.find((e: any) => e.id === "b_hero")!
  assert.deepEqual(hero.props, {})
})

test("minimalPlannerContextPack: caps pageRoutes at 6", () => {
  const pack = makeContextPack("b_hero")
  pack.pageRoutes = ["/", "/a", "/b", "/c", "/d", "/e", "/f", "/g"]
  const result = minimalPlannerContextPack({ contextPack: pack })
  assert.ok(result.pageRoutes.length <= 6)
  assert.ok(result.pageRoutes.includes("/"))
})

test("minimalPlannerContextPack: trims recentSuccessfulEdits to 1", () => {
  const pack = makeContextPack("b_hero")
  const result = minimalPlannerContextPack({ contextPack: pack })
  assert.equal(result.recentSuccessfulEdits.length, 1)
})

test("minimalPlannerContextPack: preserves resolvedReferences", () => {
  const pack = makeContextPack("b_hero")
  pack.resolvedReferences = { target: { id: "b1" } as any, anchor: null, mentionedBlocks: [{ id: "b2" } as any] }
  const result = minimalPlannerContextPack({ contextPack: pack })
  assert.deepEqual(result.resolvedReferences.target, { id: "b1" })
  assert.deepEqual(result.resolvedReferences.mentionedBlocks, [{ id: "b2" }])
})

test("minimalPlannerContextPack: returns full pack when no block selected", () => {
  const pack = makeContextPack("")
  pack.selected = { blockId: "", editablePath: null }
  const result = minimalPlannerContextPack({ contextPack: pack })
  // Should return original since no selectedBlockId
  assert.equal(result.pageOutline.length, 3)
})

// ---------------------------------------------------------------------------
// shouldUseMinimalPlannerContext
// ---------------------------------------------------------------------------

test("shouldUseMinimalPlannerContext: true for rewrite with active block", () => {
  assert.ok(shouldUseMinimalPlannerContext({
    message: "rewrite the heading",
    translationScope: "none",
    activeBlockId: "b_hero"
  }))
})

test("shouldUseMinimalPlannerContext: true for simple edit with active block", () => {
  assert.ok(shouldUseMinimalPlannerContext({
    message: "change the title text",
    translationScope: "none",
    activeBlockId: "b_hero"
  }))
})

test("shouldUseMinimalPlannerContext: false without active block", () => {
  assert.ok(!shouldUseMinimalPlannerContext({
    message: "rewrite the heading",
    translationScope: "none"
  }))
})

test("shouldUseMinimalPlannerContext: false for translations", () => {
  assert.ok(!shouldUseMinimalPlannerContext({
    message: "translate to German",
    translationScope: "page",
    activeBlockId: "b_hero"
  }))
})

test("shouldUseMinimalPlannerContext: false for page operations", () => {
  assert.ok(!shouldUseMinimalPlannerContext({
    message: "create a new page",
    translationScope: "none",
    activeBlockId: "b_hero"
  }))
})

// ---------------------------------------------------------------------------
// shouldPreferFocusedTranslation
// ---------------------------------------------------------------------------

test("shouldPreferFocusedTranslation: true when page scope but block selected, no explicit page cue", () => {
  assert.ok(shouldPreferFocusedTranslation({
    message: "translate to German",
    inferredScope: "page",
    activeBlockId: "b_hero"
  }))
})

test("shouldPreferFocusedTranslation: false when explicit page cue present", () => {
  assert.ok(!shouldPreferFocusedTranslation({
    message: "translate the entire page to German",
    inferredScope: "page",
    activeBlockId: "b_hero"
  }))
  assert.ok(!shouldPreferFocusedTranslation({
    message: "translate this page to Spanish",
    inferredScope: "page",
    activeBlockId: "b_hero"
  }))
})

test("shouldPreferFocusedTranslation: false when no block selected", () => {
  assert.ok(!shouldPreferFocusedTranslation({
    message: "translate to German",
    inferredScope: "page"
  }))
})

test("shouldPreferFocusedTranslation: false when scope is not page", () => {
  assert.ok(!shouldPreferFocusedTranslation({
    message: "translate this block",
    inferredScope: "component",
    activeBlockId: "b_hero"
  }))
})

// ---------------------------------------------------------------------------
// classifyMessageComplexity
// ---------------------------------------------------------------------------

function makePage(blocks?: PageDoc["blocks"]): PageDoc {
  return {
    id: "p_test",
    slug: "/",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: blocks ?? [
      { id: "b_hero", type: "Hero", props: { heading: "Hello", subheading: "World", ctaText: "Go", ctaHref: "/", imageUrl: "/img.png", imageAlt: "alt" } },
      { id: "b_features", type: "FeatureGrid", props: { title: "Features", features: [] } },
      { id: "b_cta", type: "CTA", props: { title: "Ready", description: "Go", ctaText: "Click", ctaHref: "/" } }
    ]
  }
}

test("classifyMessageComplexity: simple for add with clear block type", () => {
  assert.equal(classifyMessageComplexity({
    message: "add a CTA",
    currentPage: makePage(),
    translationScope: "none"
  }), "simple")
})

test("classifyMessageComplexity: simple for remove with clear block type", () => {
  assert.equal(classifyMessageComplexity({
    message: "remove the hero",
    currentPage: makePage(),
    translationScope: "none"
  }), "simple")
})

test("classifyMessageComplexity: simple for update with quoted value", () => {
  assert.equal(classifyMessageComplexity({
    message: 'change the hero heading to "New Title"',
    currentPage: makePage(),
    activeBlockId: "b_hero",
    translationScope: "none"
  }), "simple")
})

test("classifyMessageComplexity: standard for translations", () => {
  assert.equal(classifyMessageComplexity({
    message: "translate to German",
    currentPage: makePage(),
    translationScope: "page"
  }), "standard")
})

test("classifyMessageComplexity: standard for rewrites", () => {
  assert.equal(classifyMessageComplexity({
    message: "rewrite the hero heading",
    currentPage: makePage(),
    activeBlockId: "b_hero",
    translationScope: "none"
  }), "standard")
})

test("classifyMessageComplexity: standard for page operations", () => {
  assert.equal(classifyMessageComplexity({
    message: "create a new page called About",
    currentPage: makePage(),
    translationScope: "none"
  }), "standard")
})

test("classifyMessageComplexity: standard for vague update without patch", () => {
  assert.equal(classifyMessageComplexity({
    message: "make the hero more compelling",
    currentPage: makePage(),
    activeBlockId: "b_hero",
    translationScope: "none"
  }), "standard")
})

// ---------------------------------------------------------------------------
// isRouterPlanTooShallow
// ---------------------------------------------------------------------------

test("isRouterPlanTooShallow: false for simple messages without content cues", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added CTA.",
    change_log: [],
    ops: [{ op: "add_block", pageSlug: "/", afterBlockId: "b_hero", block: { id: "b_new", type: "CTA", props: { title: "Go" } } }]
  }
  assert.ok(!isRouterPlanTooShallow("add a CTA", plan))
})

test("isRouterPlanTooShallow: true when content requested but plan has short defaults", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added Hero.",
    change_log: [],
    ops: [{ op: "add_block", pageSlug: "/", afterBlockId: "b_cta", block: { id: "b_new", type: "Hero", props: { heading: "Title", subheading: "Sub" } } }]
  }
  assert.ok(isRouterPlanTooShallow("add a compelling hero about our mission statement", plan))
})

test("isRouterPlanTooShallow: false for non-edit plans", () => {
  const plan: EditPlan = {
    intent: "needs_clarification",
    summary_for_user: "What?",
    change_log: [],
    ops: []
  }
  assert.ok(!isRouterPlanTooShallow("add a compelling hero about our mission", plan))
})

test("isRouterPlanTooShallow: false when plan has rich content", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Added Hero.",
    change_log: [],
    ops: [{
      op: "add_block",
      pageSlug: "/",
      afterBlockId: "b_cta",
      block: {
        id: "b_new",
        type: "Hero",
        props: {
          heading: "Our Mission: Building the Future of Education Together",
          subheading: "We believe every student deserves access to world-class learning experiences"
        }
      }
    }]
  }
  assert.ok(!isRouterPlanTooShallow("add a compelling hero about our mission", plan))
})
