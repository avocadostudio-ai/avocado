import test from "node:test"
import assert from "node:assert/strict"
import { extractSummaryFromPlanBuffer, extractUpdatePropsFieldDraftsFromPlanBuffer } from "./planner.js"

test("extractSummaryFromPlanBuffer returns partial summary while JSON string is still open", () => {
  const raw = '{"intent":"edit_plan","summary_for_user":"**Refresh the hero copy'
  const summary = extractSummaryFromPlanBuffer(raw)
  assert.equal(summary.summary, "**Refresh the hero copy")
})

test("extractSummaryFromPlanBuffer decodes markdown-friendly escaped newlines during stream", () => {
  const raw = '{"intent":"edit_plan","summary_for_user":"- First line\\n- Second line'
  const summary = extractSummaryFromPlanBuffer(raw)
  assert.equal(summary.summary, "- First line\n- Second line")
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer returns partial update_props string drafts", () => {
  const raw = '{"intent":"edit_plan","ops":[{"op":"update_props","pageSlug":"/","blockId":"b_hero_home","patch":{"heading":"Hel'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [
    { opIndex: 1, blockId: "b_hero_home", editablePath: "heading", value: "Hel" }
  ])
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer decodes escaped and unicode values", () => {
  const raw = '{"intent":"edit_plan","ops":[{"op":"update_props","pageSlug":"/","blockId":"b_hero_home","patch":{"heading":"Line\\nBreak \\u00fc"}}]}'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [
    { opIndex: 1, blockId: "b_hero_home", editablePath: "heading", value: "Line\nBreak ü" }
  ])
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer includes multiple update_props operations", () => {
  const raw = '{"intent":"edit_plan","ops":[{"op":"update_props","pageSlug":"/","blockId":"b_hero_home","patch":{"heading":"Alpha"}},{"op":"move_block","pageSlug":"/","blockId":"b_features_home","afterBlockId":"b_hero_home"},{"op":"update_props","pageSlug":"/","blockId":"b_cta_home","patch":{"title":"Bravo","body":"Call now"}}]}'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [
    { opIndex: 1, blockId: "b_hero_home", editablePath: "heading", value: "Alpha" },
    { opIndex: 3, blockId: "b_cta_home", editablePath: "title", value: "Bravo" },
    { opIndex: 3, blockId: "b_cta_home", editablePath: "body", value: "Call now" }
  ])
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer ignores non-string patch values", () => {
  const raw = '{"intent":"edit_plan","ops":[{"op":"update_props","pageSlug":"/","blockId":"b_hero_home","patch":{"heading":123,"meta":{"foo":"bar"},"subheading":"Visible"}}]}'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [
    { opIndex: 1, blockId: "b_hero_home", editablePath: "subheading", value: "Visible" }
  ])
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer streams even before op key arrives when blockId and patch are present", () => {
  const raw = '{"intent":"edit_plan","ops":[{"pageSlug":"/","blockId":"b_hero_home","patch":{"heading":"Hel'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [
    { opIndex: 1, blockId: "b_hero_home", editablePath: "heading", value: "Hel" }
  ])
})

test("extractUpdatePropsFieldDraftsFromPlanBuffer ignores update_item-like partial ops without explicit op key", () => {
  const raw = '{"intent":"edit_plan","ops":[{"pageSlug":"/","blockId":"b_faq_home","listKey":"items","index":0,"patch":{"q":"Hel'
  const drafts = extractUpdatePropsFieldDraftsFromPlanBuffer(raw)
  assert.deepEqual(drafts, [])
})
