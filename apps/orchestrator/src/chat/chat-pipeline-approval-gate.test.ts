import test from "node:test"
import assert from "node:assert/strict"
import type { EditPlan } from "@avocadostudio-ai/shared"
import { isImageOnlyUpdatePropsPlan, applyImageSourceHint } from "./chat-pipeline.js"

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

// ---------------------------------------------------------------------------
// applyImageSourceHint
// ---------------------------------------------------------------------------

test("applyImageSourceHint: no preference → returns message unchanged", () => {
  assert.equal(applyImageSourceHint("add an image", "add an image", undefined), "add an image")
})

test("applyImageSourceHint: 'either' preference → returns message unchanged", () => {
  assert.equal(applyImageSourceHint("add an image", "add an image", "either"), "add an image")
})

test("applyImageSourceHint: unsplash preference + generic message → appends 'unsplash'", () => {
  assert.equal(applyImageSourceHint("add an image", "add an image", "unsplash"), "add an image unsplash")
})

test("applyImageSourceHint: genai preference + generic message → appends 'generate image'", () => {
  assert.equal(applyImageSourceHint("add an image", "add an image", "genai"), "add an image generate image")
})

test("applyImageSourceHint: explicit 'Generate an AI image' in message + unsplash preference → no hint (regression)", () => {
  // Regression for traceId 01bc6423: stored 'unsplash' preference leaking into an
  // explicit "Generate an AI image of a mountain" prompt caused no_effective_change.
  const msg = "Generate an AI image of a mountain"
  assert.equal(applyImageSourceHint(msg, msg, "unsplash"), msg)
})

test("applyImageSourceHint: explicit 'unsplash' in message + genai preference → no hint", () => {
  const msg = "Find an unsplash photo of avocados"
  assert.equal(applyImageSourceHint(msg, msg, "genai"), msg)
})

test("applyImageSourceHint: 'with ai' in message short-circuits", () => {
  const msg = "make a hero image with ai"
  assert.equal(applyImageSourceHint(msg, msg, "unsplash"), msg)
})

test("applyImageSourceHint: 'stock photo' in message short-circuits", () => {
  const msg = "add a stock photo of a sunset"
  assert.equal(applyImageSourceHint(msg, msg, "genai"), msg)
})
