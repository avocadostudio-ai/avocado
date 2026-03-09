import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_PLAN_VISIBLE_CHANGE_COUNT,
  normalizePlanChangeLines,
  planHasHiddenChanges,
  visiblePlanChangeLines
} from "./plan-preview.js"

test("normalizePlanChangeLines trims and removes empty lines", () => {
  assert.deepEqual(normalizePlanChangeLines(["  First  ", "", "   ", "Second"]), ["First", "Second"])
})

test("visiblePlanChangeLines shows first N lines when collapsed", () => {
  const lines = ["One", "Two", "Three", "Four"]
  const visible = visiblePlanChangeLines({
    lines,
    expanded: false,
    maxVisible: DEFAULT_PLAN_VISIBLE_CHANGE_COUNT
  })
  assert.deepEqual(visible, ["One", "Two", "Three"])
})

test("visiblePlanChangeLines returns all lines when expanded", () => {
  const lines = ["One", "Two", "Three", "Four"]
  const visible = visiblePlanChangeLines({ lines, expanded: true })
  assert.deepEqual(visible, ["One", "Two", "Three", "Four"])
})

test("planHasHiddenChanges reflects overflow", () => {
  assert.equal(planHasHiddenChanges({ lines: ["One", "Two", "Three"] }), false)
  assert.equal(planHasHiddenChanges({ lines: ["One", "Two", "Three", "Four"] }), true)
})
