import test from "node:test"
import assert from "node:assert/strict"
import { type EditPlan, type PageDoc, defaultPropsForType } from "@avocadostudio-ai/shared"
import { validateChangelogCoverage } from "./changelog-coverage-validator.js"

void defaultPropsForType

function makeDraft(page: PageDoc): Map<string, PageDoc> {
  return new Map([[page.slug, page]])
}

function fourBlockPage(): PageDoc {
  return {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: "2026-04-22T00:00:00.000Z",
    blocks: [
      { id: "hero-1", type: "Hero", props: { heading: "Welcome" } },
      { id: "richtext-1", type: "RichText", props: { title: "About", body: "Body" } },
      { id: "grid-1", type: "CardGrid", props: { title: "Cards", cards: [] } },
      { id: "cta-1", type: "CTA", props: { title: "Ready?", ctaLabel: "Go" } }
    ]
  }
}

test("validateChangelogCoverage: synthesizes fallback entries when change_log is shorter than ops", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Will make the page more playful.",
    change_log: ["Will update CardGrid cards."],
    ops: [
      { op: "update_props", pageSlug: "/test", blockId: "hero-1", patch: { heading: "Hello!" } },
      { op: "update_props", pageSlug: "/test", blockId: "richtext-1", patch: { title: "About!" } },
      { op: "update_props", pageSlug: "/test", blockId: "grid-1", patch: { title: "Cards!" } },
      { op: "update_props", pageSlug: "/test", blockId: "cta-1", patch: { title: "Ready!" } }
    ]
  }

  const result = validateChangelogCoverage({ plan, draft: makeDraft(fourBlockPage()) })

  assert.equal(result.missingCount, 3)
  assert.equal(result.synthesizedEntries.length, 3)
  assert.equal(result.plan.change_log.length, 4, "change_log should now match ops length")
  // First entry preserved, remaining three synthesized
  assert.equal(result.plan.change_log[0], "Will update CardGrid cards.")
  assert.match(result.plan.change_log[1], /Rich Text/)
  assert.match(result.plan.change_log[2], /Card Grid|CardGrid/)
  assert.match(result.plan.change_log[3], /Call to Action|CTA/)
})

test("validateChangelogCoverage: no-op when change_log already covers all ops", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Will update two blocks.",
    change_log: ["Will update Hero.", "Will update CTA."],
    ops: [
      { op: "update_props", pageSlug: "/test", blockId: "hero-1", patch: { heading: "Hi" } },
      { op: "update_props", pageSlug: "/test", blockId: "cta-1", patch: { title: "Go" } }
    ]
  }

  const result = validateChangelogCoverage({ plan, draft: makeDraft(fourBlockPage()) })

  assert.equal(result.missingCount, 0)
  assert.equal(result.synthesizedEntries.length, 0)
  assert.equal(result.plan.change_log.length, 2)
})

test("validateChangelogCoverage: skips non-edit_plan intents", () => {
  const plan: EditPlan = {
    intent: "content_answer",
    summary_for_user: "There are 4 blocks on this page.",
    change_log: ["Found 4 blocks"],
    ops: []
  }

  const result = validateChangelogCoverage({ plan, draft: makeDraft(fourBlockPage()) })

  assert.equal(result.missingCount, 0)
  assert.equal(result.plan.change_log.length, 1)
})

test("validateChangelogCoverage: handles add_block op with block type in synthesized entry", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Will add a new section.",
    change_log: [],
    ops: [
      {
        op: "add_block",
        pageSlug: "/test",
        block: { id: "cta-2", type: "CTA", props: { title: "New" } }
      }
    ]
  }

  const result = validateChangelogCoverage({ plan, draft: makeDraft(fourBlockPage()) })

  assert.equal(result.missingCount, 1)
  assert.match(result.plan.change_log[0], /add.*(Call to Action|CTA)/i)
})

test("validateChangelogCoverage: empty ops list is a no-op", () => {
  const plan: EditPlan = {
    intent: "edit_plan",
    summary_for_user: "Nothing to do.",
    change_log: [],
    ops: []
  }

  const result = validateChangelogCoverage({ plan, draft: makeDraft(fourBlockPage()) })

  assert.equal(result.missingCount, 0)
  assert.equal(result.plan.change_log.length, 0)
})
