import test from "node:test"
import assert from "node:assert/strict"
import {
  isRewriteLikeMessage,
  isPerformanceAwareMessage,
  isLikelyTextField,
  collectChangedTextFields,
  buildMetaChangeLogEntries,
  buildAiInsightChanges,
  buildOpChangeLogEntries,
  deterministicCreatePagePlan,
  deterministicDuplicatePagePlan,
  shouldReturnDeterministicClarification
} from "./chat-pipeline-deterministic.js"
import type { Operation, EditPlan } from "@avocadostudio-ai/shared"

// ---------------------------------------------------------------------------
// isRewriteLikeMessage
// ---------------------------------------------------------------------------

test("isRewriteLikeMessage: matches rewrite verbs", () => {
  assert.ok(isRewriteLikeMessage("rewrite the hero heading"))
  assert.ok(isRewriteLikeMessage("Rephrase this copy"))
  assert.ok(isRewriteLikeMessage("polish the text"))
  assert.ok(isRewriteLikeMessage("tighten the messaging"))
  assert.ok(isRewriteLikeMessage("clarify the description"))
  assert.ok(isRewriteLikeMessage("clean up the wording"))
  assert.ok(isRewriteLikeMessage("optimize the content"))
  assert.ok(isRewriteLikeMessage("refresh the page text"))
  assert.ok(isRewriteLikeMessage("refine the copy"))
  assert.ok(isRewriteLikeMessage("freshen up the messaging"))
})

test("isRewriteLikeMessage: matches compound patterns", () => {
  assert.ok(isRewriteLikeMessage("redo the copy on this page"))
  assert.ok(isRewriteLikeMessage("make the text shorter"))
  assert.ok(isRewriteLikeMessage("make it clearer"))
  assert.ok(isRewriteLikeMessage("make the wording more concise"))
  assert.ok(isRewriteLikeMessage("improve the copy here"))
  assert.ok(isRewriteLikeMessage("change the tone of the text"))
  assert.ok(isRewriteLikeMessage("review the content for clarity"))
})

test("isRewriteLikeMessage: rejects non-rewrite messages", () => {
  assert.ok(!isRewriteLikeMessage("add a new section"))
  assert.ok(!isRewriteLikeMessage("delete the hero"))
  assert.ok(!isRewriteLikeMessage("translate to German"))
  assert.ok(!isRewriteLikeMessage("change the background color"))
  assert.ok(!isRewriteLikeMessage("move the CTA above the features"))
})

test("isRewriteLikeMessage: word 'rewrite' inside quoted block name is still detected", () => {
  // This is a known behavior — the regex matches 'rewrite' anywhere
  assert.ok(isRewriteLikeMessage('update the "rewrite section" heading'))
})

// ---------------------------------------------------------------------------
// isPerformanceAwareMessage
// ---------------------------------------------------------------------------

test("isPerformanceAwareMessage: matches SEO/conversion keywords", () => {
  assert.ok(isPerformanceAwareMessage("optimize for SEO"))
  assert.ok(isPerformanceAwareMessage("add keywords to the heading"))
  assert.ok(isPerformanceAwareMessage("improve conversion rate"))
  assert.ok(isPerformanceAwareMessage("check accessibility"))
  assert.ok(isPerformanceAwareMessage("improve readability"))
  assert.ok(isPerformanceAwareMessage("update the CTA for performance"))
})

test("isPerformanceAwareMessage: rejects unrelated messages", () => {
  assert.ok(!isPerformanceAwareMessage("add a new section"))
  assert.ok(!isPerformanceAwareMessage("change the heading text"))
  assert.ok(!isPerformanceAwareMessage("translate to Spanish"))
})

// ---------------------------------------------------------------------------
// isLikelyTextField
// ---------------------------------------------------------------------------

test("isLikelyTextField: accepts text-like keys", () => {
  assert.ok(isLikelyTextField("heading"))
  assert.ok(isLikelyTextField("title"))
  assert.ok(isLikelyTextField("description"))
  assert.ok(isLikelyTextField("ctaText"))
  assert.ok(isLikelyTextField("subheading"))
})

test("isLikelyTextField: rejects URL/image/icon keys", () => {
  assert.ok(!isLikelyTextField("href"))
  assert.ok(!isLikelyTextField("url"))
  assert.ok(!isLikelyTextField("image"))
  assert.ok(!isLikelyTextField("icon"))
  assert.ok(!isLikelyTextField("id"))
  assert.ok(!isLikelyTextField("props.href"))
  assert.ok(!isLikelyTextField("nested.image"))
})

test("isLikelyTextField: returns false for empty string", () => {
  assert.ok(!isLikelyTextField(""))
})

// ---------------------------------------------------------------------------
// collectChangedTextFields
// ---------------------------------------------------------------------------

test("collectChangedTextFields: extracts text fields from update_props", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "New", subheading: "Sub" } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields.sort(), ["heading", "subheading"])
})

test("collectChangedTextFields: excludes URL/image fields", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "New", href: "https://example.com", image: "/img.png" } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields, ["heading"])
})

test("collectChangedTextFields: excludes empty string values", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "New", subheading: "  " } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields, ["heading"])
})

test("collectChangedTextFields: excludes non-string values", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "New", count: 5, active: true } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields, ["heading"])
})

test("collectChangedTextFields: handles update_item with listKey prefix", () => {
  const ops: Operation[] = [
    { op: "update_item", pageSlug: "/", blockId: "b1", listKey: "features", index: 0, patch: { title: "Fast", description: "Speed" } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields.sort(), ["features.description", "features.title"])
})

test("collectChangedTextFields: ignores non-prop ops", () => {
  const ops: Operation[] = [
    { op: "add_block", pageSlug: "/", afterBlockId: "b1", block: { id: "b2", type: "CTA", props: { title: "Go" } } },
    { op: "remove_block", pageSlug: "/", blockId: "b1" }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields, [])
})

test("collectChangedTextFields: deduplicates across multiple ops", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "A" } },
    { op: "update_props", pageSlug: "/", blockId: "b2", patch: { heading: "B" } }
  ]
  const fields = collectChangedTextFields(ops)
  assert.deepEqual(fields, ["heading"])
})

// ---------------------------------------------------------------------------
// buildMetaChangeLogEntries
// ---------------------------------------------------------------------------

test("buildMetaChangeLogEntries: extracts title and description", () => {
  const ops: Operation[] = [
    { op: "update_page_meta", pageSlug: "/", patch: { title: "New Title", description: "New desc" } }
  ]
  const lines = buildMetaChangeLogEntries(ops)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes("New Title"))
  assert.ok(lines[1].includes("New desc"))
})

test("buildMetaChangeLogEntries: extracts ogImage", () => {
  const ops: Operation[] = [
    { op: "update_page_meta", pageSlug: "/", patch: { ogImage: "https://img.com/og.png" } }
  ]
  const lines = buildMetaChangeLogEntries(ops)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes("og.png"))
})

test("buildMetaChangeLogEntries: ignores empty values", () => {
  const ops: Operation[] = [
    { op: "update_page_meta", pageSlug: "/", patch: { title: "", description: "Valid" } }
  ]
  const lines = buildMetaChangeLogEntries(ops)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes("Valid"))
})

test("buildMetaChangeLogEntries: ignores non-meta ops", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "X" } }
  ]
  const lines = buildMetaChangeLogEntries(ops)
  assert.deepEqual(lines, [])
})

// ---------------------------------------------------------------------------
// buildAiInsightChanges
// ---------------------------------------------------------------------------

test("buildAiInsightChanges: returns justification for rewrite messages", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Rewrote heading",
    change_log: [],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "Better" } }]
  }
  const lines = buildAiInsightChanges({ plan, message: "rewrite the heading" })
  assert.ok(lines.length > 0)
  assert.ok(lines.some((l) => l.includes("__ai_justification__")))
})

test("buildAiInsightChanges: returns performance insight for SEO messages", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Optimized",
    change_log: [],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "Better" } }]
  }
  const lines = buildAiInsightChanges({ plan, message: "optimize for SEO" })
  assert.ok(lines.some((l) => l.includes("__ai_performance__")))
})

test("buildAiInsightChanges: returns empty for non-edit intents", () => {
  const plan: EditPlan = {
    intent: "needs_clarification",
    summary_for_user: "What?",
    change_log: [],
    ops: []
  }
  const lines = buildAiInsightChanges({ plan, message: "rewrite the heading" })
  assert.deepEqual(lines, [])
})

test("buildAiInsightChanges: returns empty for translation messages", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Translated",
    change_log: [],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b1", patch: { heading: "Hallo" } }]
  }
  const lines = buildAiInsightChanges({ plan, message: "translate to German" })
  assert.deepEqual(lines, [])
})

test("buildAiInsightChanges: returns empty when no text fields changed", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updated",
    change_log: [],
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b1", patch: { href: "https://x.com" } }]
  }
  const lines = buildAiInsightChanges({ plan, message: "rewrite the heading" })
  assert.deepEqual(lines, [])
})

// ---------------------------------------------------------------------------
// shouldReturnDeterministicClarification
// ---------------------------------------------------------------------------

test("shouldReturnDeterministicClarification: matches page delete requests", () => {
  assert.ok(shouldReturnDeterministicClarification("delete the page"))
  assert.ok(shouldReturnDeterministicClarification("remove this page"))
})

test("shouldReturnDeterministicClarification: matches rename/move page requests", () => {
  assert.ok(shouldReturnDeterministicClarification("rename the page to About"))
  assert.ok(shouldReturnDeterministicClarification("move the page to /new-path"))
})

test("shouldReturnDeterministicClarification: rejects non-page ops", () => {
  assert.ok(!shouldReturnDeterministicClarification("change the heading"))
  assert.ok(!shouldReturnDeterministicClarification("add a features section"))
})

test("shouldReturnDeterministicClarification: rejects batch-add requests like 'populate this page'", () => {
  // These should NOT short-circuit to clarification — the full planner should handle them
  assert.ok(!shouldReturnDeterministicClarification("populate this page with 3 blocks and sample content"))
  assert.ok(!shouldReturnDeterministicClarification("populate this page with content"))
  assert.ok(!shouldReturnDeterministicClarification("fill out the page with hero, cardgrid and CTA"))
  assert.ok(!shouldReturnDeterministicClarification("add 3 blocks with sample content"))
})

// ---------------------------------------------------------------------------
// deterministicCreatePagePlan — template deferral
// ---------------------------------------------------------------------------

test("deterministicCreatePagePlan: defers to LLM when message mentions template and templates are available", () => {
  const message = "add a new page /campaign using a Campaign Landing Page template"
  const result = deterministicCreatePagePlan({ session: "test-template-defer", message, hasPageTemplates: true })
  assert.equal(result, null, "should return null to defer to LLM planner")
})

test("deterministicCreatePagePlan: does NOT defer when no templates available", () => {
  const message = "add a new page /campaign using a Campaign Landing Page template"
  const result = deterministicCreatePagePlan({ session: "test-template-no-defer", message, hasPageTemplates: false })
  assert.ok(result !== null, "should create page deterministically when no templates available")
  assert.equal(result!.ops[0].op, "create_page")
})

test("deterministicCreatePagePlan: does NOT defer when templates exist but message does not mention template", () => {
  const message = "add a new page /about"
  const result = deterministicCreatePagePlan({ session: "test-template-no-mention", message, hasPageTemplates: true })
  assert.ok(result !== null, "should create page deterministically when user doesn't mention template")
  assert.equal(result!.ops[0].op, "create_page")
})

test("deterministicCreatePagePlan: defers to LLM on detailed page spec (numbered block list + 'blocks in order')", () => {
  const message = `Create a new page at /test titled Test Page with playful sample content. Build page to match this spec: Page /test — blocks (in order): 1. Hero — heading 🎉 Welcome to the Playground 2. CardGrid with 3 cards 3. FAQAccordion 4. CTA`
  const result = deterministicCreatePagePlan({ session: "test-detailed-spec", message, hasPageTemplates: false })
  assert.equal(result, null, "should defer detailed specs to the LLM planner so all blocks are honored")
})

test("deterministicCreatePagePlan: defers on 'build page to match'", () => {
  const message = "Create /foo. Build page to match the screenshot"
  const result = deterministicCreatePagePlan({ session: "test-build-to-match", message, hasPageTemplates: false })
  assert.equal(result, null)
})

test("deterministicCreatePagePlan: defers when target slug already exists (edit-phrased-as-create)", () => {
  // "test-suite" session is auto-seeded from demoPublishedPages — /pricing exists.
  const message = "make page /pricing have: 1. Hero 2. RichText 3. CardGrid 4. CTA"
  const result = deterministicCreatePagePlan({ session: "test-suite", message, hasPageTemplates: false })
  assert.equal(result, null, "existing-slug creates should defer to the LLM so it can plan edits instead of clarifying")
})

// ---------------------------------------------------------------------------
// deterministicDuplicatePagePlan — content-generation deferral
// ---------------------------------------------------------------------------

test("deterministicDuplicatePagePlan: bare duplicate stays deterministic", () => {
  // /pricing is auto-seeded into test-suite from demoPublishedPages.
  const message = "duplicate this page into a new one called pricing copy"
  const result = deterministicDuplicatePagePlan({ session: "test-suite", message, effectiveSlug: "/pricing" })
  assert.ok(result, "bare duplicate should produce a deterministic plan")
  assert.equal(result!.ops.length, 1)
  assert.equal(result!.ops[0]?.op, "duplicate_page")
})

test("deterministicDuplicatePagePlan: defers to LLM when message also asks to suggest/populate components", () => {
  const message = "duplicate this page into a new one called season recipes. suggest components and populate them. make a plan first"
  const result = deterministicDuplicatePagePlan({ session: "test-suite", message, effectiveSlug: "/pricing" })
  assert.equal(result, null, "should defer to LLM so it can plan duplicate_page + add_block + update_props together")
})

// ---------------------------------------------------------------------------
// buildOpChangeLogEntries
// ---------------------------------------------------------------------------

const noopCtx = { getBlockType: () => undefined }
const heroCtx = { getBlockType: () => "Hero" as string | undefined }

test("buildOpChangeLogEntries: create_page", () => {
  const ops: Operation[] = [
    { op: "create_page", page: { id: "p1", slug: "about", title: "About Us", updatedAt: "2024-01-01", blocks: [] } }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes("About Us"))
  assert.ok(lines[0].includes("/about"))
})

test("buildOpChangeLogEntries: add_block includes block type", () => {
  const ops: Operation[] = [
    { op: "add_block", pageSlug: "home", block: { id: "b1", type: "CTA", props: { heading: "Go" } } }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes("CTA"))
  assert.ok(lines[0].includes("/home"))
})

test("buildOpChangeLogEntries: remove_block uses ctx for type", () => {
  const ops: Operation[] = [
    { op: "remove_block", pageSlug: "home", blockId: "b1" }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("Hero"))
  assert.ok(lines[0].includes("Removed"))
})

test("buildOpChangeLogEntries: update_props with imageUrl mentions image", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "home", blockId: "b1", patch: { props: { imageUrl: "https://img.com/a.jpg" } } }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("image"))
  assert.ok(lines[0].includes("Hero"))
})

test("buildOpChangeLogEntries: update_props with text fields lists them", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "home", blockId: "b1", patch: { heading: "New", subheading: "Sub" } }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("heading"))
  assert.ok(lines[0].includes("subheading"))
})

test("buildOpChangeLogEntries: update_props with image and text fields", () => {
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "home", blockId: "b1", patch: { heading: "New", imageUrl: "https://img.com/a.jpg" } }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("image"))
  assert.ok(lines[0].includes("heading"))
})

test("buildOpChangeLogEntries: update_item with image field", () => {
  const ops: Operation[] = [
    { op: "update_item", pageSlug: "home", blockId: "b1", listKey: "cards", index: 0, patch: { imageUrl: "https://img.com/b.jpg" } }
  ]
  const lines = buildOpChangeLogEntries(ops, { getBlockType: () => "CardGrid" })
  assert.ok(lines[0].includes("item image"))
  assert.ok(lines[0].includes("CardGrid"))
})

test("buildOpChangeLogEntries: add_item and remove_item", () => {
  const ops: Operation[] = [
    { op: "add_item", pageSlug: "home", blockId: "b1", listKey: "features", item: { title: "Fast" } },
    { op: "remove_item", pageSlug: "home", blockId: "b1", listKey: "features", index: 2 }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes("Added item"))
  assert.ok(lines[1].includes("Removed item"))
})

test("buildOpChangeLogEntries: move_block and duplicate_block", () => {
  const ops: Operation[] = [
    { op: "move_block", pageSlug: "home", blockId: "b1" },
    { op: "duplicate_block", pageSlug: "home", blockId: "b1" }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("Moved"))
  assert.ok(lines[1].includes("Duplicated"))
})

test("buildOpChangeLogEntries: rename_page", () => {
  const ops: Operation[] = [
    { op: "rename_page", pageSlug: "old-name", newPageSlug: "new-name", newTitle: "New Name" }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.ok(lines[0].includes("/old-name"))
  assert.ok(lines[0].includes("/new-name"))
  assert.ok(lines[0].includes("New Name"))
})

test("buildOpChangeLogEntries: remove_page and duplicate_page", () => {
  const ops: Operation[] = [
    { op: "remove_page", pageSlug: "old" },
    { op: "duplicate_page", pageSlug: "home", newPageSlug: "home-copy" }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.ok(lines[0].includes("Removed"))
  assert.ok(lines[0].includes("/old"))
  assert.ok(lines[1].includes("Duplicated"))
  assert.ok(lines[1].includes("/home-copy"))
})

test("buildOpChangeLogEntries: move_page and move_item", () => {
  const ops: Operation[] = [
    { op: "move_page", pageSlug: "about" },
    { op: "move_item", pageSlug: "home", blockId: "b1", listKey: "cards", index: 0, afterIndex: 2 }
  ]
  const lines = buildOpChangeLogEntries(ops, heroCtx)
  assert.ok(lines[0].includes("Reordered page"))
  assert.ok(lines[1].includes("Reordered item"))
})

test("buildOpChangeLogEntries: update_page_meta is skipped (handled by buildMetaChangeLogEntries)", () => {
  const ops: Operation[] = [
    { op: "update_page_meta", pageSlug: "home", patch: { title: "New Title" } }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.deepEqual(lines, [])
})

test("buildOpChangeLogEntries: update_site_config", () => {
  const ops: Operation[] = [
    { op: "update_site_config", patch: { name: "My Site", logo: "/logo.png" } }
  ]
  const lines = buildOpChangeLogEntries(ops, noopCtx)
  assert.ok(lines.some((l) => l.includes("My Site")))
  assert.ok(lines.some((l) => l.includes("logo")))
})
