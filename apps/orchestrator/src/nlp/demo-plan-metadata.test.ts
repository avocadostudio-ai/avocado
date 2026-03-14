import test from "node:test"
import assert from "node:assert/strict"
import { demoPlanFromMessage } from "./deterministic-planner.js"

test("demoPlanFromMessage: 'Add metadata' with title and description generates update_page_meta", () => {
  const plan = demoPlanFromMessage(
    "Add metadata to the Olives page with the title 'Olives - A Mediterranean Treasure' and description 'Discover the rich flavors of olives, their nutritional advantages, and how they enhance every meal'",
    "/olives"
  )
  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].op, "update_page_meta")
  const op = plan.ops[0] as { op: string; pageSlug: string; patch: Record<string, string> }
  assert.equal(op.pageSlug, "/olives")
  assert.equal(op.patch.title, "Olives - A Mediterranean Treasure")
  assert.equal(op.patch.description, "Discover the rich flavors of olives, their nutritional advantages, and how they enhance every meal")
})

test("demoPlanFromMessage: 'set meta description' with single-quoted value", () => {
  const plan = demoPlanFromMessage(
    "set meta description to 'A guide to Mediterranean olives'",
    "/olives"
  )
  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops.length, 1)
  assert.equal(plan.ops[0].op, "update_page_meta")
  const op = plan.ops[0] as { op: string; pageSlug: string; patch: Record<string, string> }
  assert.equal(op.patch.description, "A guide to Mediterranean olives")
})

test("demoPlanFromMessage: 'add metadata' with only title generates update_page_meta", () => {
  const plan = demoPlanFromMessage(
    "add metadata with the title 'My Page Title'",
    "/test"
  )
  assert.equal(plan.intent, "edit_plan")
  assert.equal(plan.ops[0].op, "update_page_meta")
  const op = plan.ops[0] as { op: string; pageSlug: string; patch: Record<string, string> }
  assert.equal(op.patch.title, "My Page Title")
  assert.equal(op.patch.description, undefined)
})
