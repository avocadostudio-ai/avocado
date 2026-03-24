import test from "node:test"
import assert from "node:assert/strict"
import {
  isRewriteLikeMessage,
  isPerformanceAwareMessage,
  isLikelyTextField,
  collectChangedTextFields,
  buildMetaChangeLogEntries,
  buildAiInsightChanges,
  deterministicCreatePagePlan,
  shouldReturnDeterministicClarification
} from "./chat-pipeline-deterministic.js"
import type { Operation, EditPlan } from "@ai-site-editor/shared"

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

// ---------------------------------------------------------------------------
// deterministicCreatePagePlan — template deferral
// ---------------------------------------------------------------------------

test("deterministicCreatePagePlan: defers to LLM when message mentions template and templates exist in context", () => {
  const messageWithTemplates = [
    "add a new page /campaign using a Campaign Landing Page template",
    "[site context]",
    "Page templates:",
    "- Campaign Landing Page: Hero with bold CTA, FeatureGrid, Testimonials, CTA",
    "[/site context]"
  ].join("\n")
  const result = deterministicCreatePagePlan({ session: "test-template-defer", message: messageWithTemplates })
  assert.equal(result, null, "should return null to defer to LLM planner")
})

test("deterministicCreatePagePlan: does NOT defer when no templates in context", () => {
  const messageWithoutTemplates = "add a new page /campaign using a Campaign Landing Page template"
  const result = deterministicCreatePagePlan({ session: "test-template-no-defer", message: messageWithoutTemplates })
  assert.ok(result !== null, "should create page deterministically when no templates available")
  assert.equal(result!.ops[0].op, "create_page")
})

test("deterministicCreatePagePlan: does NOT defer when templates exist but message does not mention template", () => {
  const messageNoTemplateMention = [
    "add a new page /about",
    "[site context]",
    "Page templates:",
    "- Campaign Landing Page: Hero with bold CTA, FeatureGrid, Testimonials, CTA",
    "[/site context]"
  ].join("\n")
  const result = deterministicCreatePagePlan({ session: "test-template-no-mention", message: messageNoTemplateMention })
  assert.ok(result !== null, "should create page deterministically when user doesn't mention template")
  assert.equal(result!.ops[0].op, "create_page")
})
