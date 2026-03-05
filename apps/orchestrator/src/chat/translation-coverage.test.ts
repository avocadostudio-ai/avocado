import test from "node:test"
import assert from "node:assert/strict"
import { findFullPageTranslationCoverageGap } from "./chat-pipeline.js"

test("translation coverage: flags missing CardGrid child fields", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cards",
        type: "CardGrid" as const,
        props: {
          title: "Cards",
          cards: [
            { title: "A", description: "Desc A", ctaText: "Learn", ctaHref: "/" },
            { title: "B", description: "Desc B", ctaText: "Learn", ctaHref: "/" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [
        { op: "update_item", pageSlug: "/test", blockId: "b_cards", listKey: "cards", index: 0, patch: { title: "Titel A" } },
        { op: "update_item", pageSlug: "/test", blockId: "b_cards", listKey: "cards", index: 1, patch: { title: "Titel B" } }
      ]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /cards\[0\]\.description/i)
  assert.match(String(gap), /cards\[0\]\.ctaText/i)
})

test("translation coverage: flags missing child fields for non-CardGrid list blocks", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_features",
        type: "FeatureGrid" as const,
        props: {
          title: "Features",
          features: [
            { title: "Speed", description: "Fast setup" },
            { title: "Safety", description: "Secure changes" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [{ op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 0, patch: { title: "Snelheid" } }]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /features\[0\]\.description/i)
})

test("translation coverage: passes when list child text coverage is complete", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_features",
        type: "FeatureGrid" as const,
        props: {
          title: "Features",
          features: [
            { title: "Speed", description: "Fast setup" },
            { title: "Safety", description: "Secure changes" }
          ]
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page",
      change_log: [],
      ops: [
        { op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 0, patch: { title: "Snelheid", description: "Snelle opzet" } },
        { op: "update_item", pageSlug: "/test", blockId: "b_features", listKey: "features", index: 1, patch: { title: "Veiligheid", description: "Veilige wijzigingen" } }
      ]
    },
    message: "translate whole page to dutch",
    currentPage: page,
    slug: "/test"
  })
  assert.equal(gap, null)
})
