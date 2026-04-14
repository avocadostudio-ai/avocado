import test from "node:test"
import assert from "node:assert/strict"
import type { EditPlan } from "@ai-site-editor/shared"
import { isImageOnlyUpdatePropsPlan } from "./chat-pipeline.js"

function makePlan(ops: EditPlan["ops"]): EditPlan {
  return {
    intent: "edit_plan",
    summary_for_user: "test",
    change_log: [],
    ops
  }
}

test("isImageOnlyUpdatePropsPlan: single update_props touching only imageUrl → true", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { imageUrl: "pending" } } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), true)
})

test("isImageOnlyUpdatePropsPlan: imageUrl + imageAlt only → true", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { imageUrl: "pending", imageAlt: "fresh avocados" } } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), true)
})

test("isImageOnlyUpdatePropsPlan: ogImage / logoUrl alone → true", () => {
  assert.equal(isImageOnlyUpdatePropsPlan(makePlan([
    { op: "update_props", pageSlug: "/", blockId: "header-1", patch: { props: { logoUrl: "pending" } } }
  ])), true)
  assert.equal(isImageOnlyUpdatePropsPlan(makePlan([
    { op: "update_props", pageSlug: "/", blockId: "meta", patch: { props: { ogImage: "pending" } } }
  ])), true)
})

test("isImageOnlyUpdatePropsPlan: flat patch (no props wrapper) → true when image-only", () => {
  const plan = makePlan([
    // Some ops in the codebase use a flat patch without the props wrapper.
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { imageUrl: "pending", imageAlt: "alt" } as Record<string, unknown> }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), true)
})

test("isImageOnlyUpdatePropsPlan: heading alongside imageUrl → false (compound plan)", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { heading: "Hello", imageUrl: "pending" } } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), false)
})

test("isImageOnlyUpdatePropsPlan: add_block op present → false", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { imageUrl: "pending" } } },
    { op: "add_block", pageSlug: "/", block: { id: "cta-1", type: "CTA", props: {} } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), false)
})

test("isImageOnlyUpdatePropsPlan: empty patch → false", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: {} } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), false)
})

test("isImageOnlyUpdatePropsPlan: no ops → false", () => {
  assert.equal(isImageOnlyUpdatePropsPlan(makePlan([])), false)
})

test("isImageOnlyUpdatePropsPlan: non-edit_plan intent → false", () => {
  const plan: EditPlan = {
    intent: "needs_clarification",
    summary_for_user: "?",
    change_log: [],
    ops: [
      { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { imageUrl: "pending" } } }
    ]
  }
  assert.equal(isImageOnlyUpdatePropsPlan(plan), false)
})

test("isImageOnlyUpdatePropsPlan: multi-block image-only plan → true", () => {
  const plan = makePlan([
    { op: "update_props", pageSlug: "/", blockId: "hero-1", patch: { props: { imageUrl: "pending" } } },
    { op: "update_props", pageSlug: "/about", blockId: "hero-2", patch: { props: { imageUrl: "pending", imageAlt: "team" } } }
  ])
  assert.equal(isImageOnlyUpdatePropsPlan(plan), true)
})
