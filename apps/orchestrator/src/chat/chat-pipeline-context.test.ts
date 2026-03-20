import test from "node:test"
import assert from "node:assert/strict"
import {
  shouldPreferFastModelForMessage,
  shouldUseLlmIntentRouter,
  compactPlannerContextPack,
  minimalPlannerContextPack,
  shouldUseMinimalPlannerContext,
  shouldPreferFocusedTranslation
} from "./chat-pipeline-context.js"

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

test("minimalPlannerContextPack: nulls out resolvedReferences", () => {
  const pack = makeContextPack("b_hero")
  pack.resolvedReferences = { target: { id: "b1" } as any, anchor: null, mentionedBlocks: [{ id: "b2" } as any] }
  const result = minimalPlannerContextPack({ contextPack: pack })
  assert.equal(result.resolvedReferences.target, null)
  assert.deepEqual(result.resolvedReferences.mentionedBlocks, [])
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
