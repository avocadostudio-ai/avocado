import test from "node:test"
import assert from "node:assert/strict"
import { type EditPlan, type PageDoc, defaultPropsForType } from "@avocadostudio-ai/shared"
import { validateAndStripHallucinatedProps } from "./hallucination-validator.js"

// Touch the shared registry so all block types (Stats, etc.) are registered.
void defaultPropsForType

function makeDraft(page: PageDoc): Map<string, PageDoc> {
  return new Map([[page.slug, page]])
}

function statsPage(): PageDoc {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: "2026-03-03T00:00:00.000Z",
    blocks: [
      {
        id: "stats-1",
        type: "Stats",
        props: {
          title: "By the numbers",
          stats: [
            { value: "10k+", label: "Users" },
            { value: "99.9%", label: "Uptime" }
          ]
        }
      }
    ]
  }
}

test("validateAndStripHallucinatedProps: strips unsupported Stats color prop and annotates summary", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Adding icons and colors to the stats.",
    change_log: ["Added icons", "Added colors"],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "stats-1",
        patch: {
          color: "red",
          title: "Updated title"
        }
      }
    ]
  }

  const result = validateAndStripHallucinatedProps({ plan, draft: makeDraft(statsPage()) })

  assert.equal(result.hallucinatedProps.length, 1, "one hallucinated prop should be flagged")
  assert.equal(result.hallucinatedProps[0].blockId, "stats-1")
  assert.equal(result.hallucinatedProps[0].blockType, "Stats")
  assert.equal(result.hallucinatedProps[0].propName, "color")

  const op = result.plan.ops[0]
  assert.equal(op.op, "update_props")
  if (op.op === "update_props") {
    const patch = op.patch as Record<string, unknown>
    assert.equal("color" in patch, false, "color should be stripped from the patch")
    assert.equal(patch.title, "Updated title", "valid props survive")
  }

  // Note stays generic on purpose — no raw prop names leak into user copy.
  assert.match(result.plan.summary_for_user, /Stats block/)
  assert.match(result.plan.summary_for_user, /isn't available/)
  assert.doesNotMatch(
    result.plan.summary_for_user,
    /\bcolor\b/,
    "user-facing note must not echo the raw prop name"
  )
  assert.ok(
    result.plan.change_log.some((entry) => /isn't available/.test(entry)),
    "change_log should carry the note as well"
  )
})

test("validateAndStripHallucinatedProps: tolerates patch wrapped in { props: ... }", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Change the Stats block.",
    change_log: [],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "stats-1",
        patch: {
          props: {
            gradient: "sunset",
            title: "Hello"
          }
        } as unknown as Record<string, unknown>
      }
    ]
  }

  const result = validateAndStripHallucinatedProps({ plan, draft: makeDraft(statsPage()) })
  assert.equal(result.hallucinatedProps.length, 1)
  assert.equal(result.hallucinatedProps[0].propName, "gradient")

  const op = result.plan.ops[0]
  if (op.op === "update_props") {
    const outer = op.patch as Record<string, unknown>
    const inner = outer.props as Record<string, unknown>
    assert.equal("gradient" in inner, false)
    assert.equal(inner.title, "Hello")
  }
})

test("validateAndStripHallucinatedProps: no-op when all props are valid", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updating the title.",
    change_log: ["Title updated"],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "stats-1",
        patch: { title: "New title" }
      }
    ]
  }

  const before = plan.summary_for_user
  const result = validateAndStripHallucinatedProps({ plan, draft: makeDraft(statsPage()) })

  assert.equal(result.hallucinatedProps.length, 0)
  assert.equal(result.plan.summary_for_user, before, "summary untouched when nothing stripped")
  assert.equal(result.plan.change_log.length, 1)
})

test("validateAndStripHallucinatedProps: merges multiple stripped props for same block", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Styling the stats.",
    change_log: [],
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "stats-1",
        patch: { color: "red", gradient: "sunset", animation: "fade" }
      }
    ]
  }

  const result = validateAndStripHallucinatedProps({ plan, draft: makeDraft(statsPage()) })
  assert.equal(result.hallucinatedProps.length, 3)
  // One consolidated note — no raw prop names. Still confirms all three
  // were reported via the structured return value.
  assert.match(result.plan.summary_for_user, /Stats block/)
  assert.match(result.plan.summary_for_user, /isn't available/)
  assert.doesNotMatch(result.plan.summary_for_user, /\b(color|gradient|animation)\b/)
  const stripped = result.hallucinatedProps.map((h) => h.propName).sort()
  assert.deepEqual(stripped, ["animation", "color", "gradient"])
})

test("validateAndStripHallucinatedProps: skips unregistered block types", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Updating custom block.",
    change_log: [],
    ops: [
      {
        op: "update_props",
        pageSlug: "/custom",
        blockId: "custom-1",
        patch: { whatever: "value" }
      }
    ]
  }
  const customPage: PageDoc = {
    id: "p_custom",
    slug: "/custom",
    title: "Custom",
    updatedAt: "2026-03-03T00:00:00.000Z",
    blocks: [{ id: "custom-1", type: "NotARegisteredType", props: {} }]
  }
  const result = validateAndStripHallucinatedProps({ plan, draft: new Map([[customPage.slug, customPage]]) })
  assert.equal(result.hallucinatedProps.length, 0, "unregistered types skip validation")
})
