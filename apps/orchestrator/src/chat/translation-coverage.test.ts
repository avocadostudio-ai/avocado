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
  // Top-level title also flagged
  assert.match(String(gap), /b_cards\.title/i)
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
  // Top-level title also flagged
  assert.match(String(gap), /b_features\.title/i)
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
        { op: "update_props", pageSlug: "/test", blockId: "b_features", patch: { title: "Functies" } },
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

// ---------------------------------------------------------------------------
// Top-level prop coverage
// ---------------------------------------------------------------------------

test("translation coverage: flags missing Hero top-level props", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero",
        type: "Hero" as const,
        props: {
          heading: "Build with confidence",
          subheading: "Make changes safely.",
          ctaText: "Get Started",
          ctaHref: "/",
          imageUrl: "/hero.svg",
          imageAlt: "Abstract illustration",
          imagePosition: "right"
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page to German",
      change_log: [],
      ops: [
        { op: "update_props", pageSlug: "/test", blockId: "b_hero", patch: { heading: "Mit Vertrauen bauen" } }
      ]
    },
    message: "translate this page to german",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /b_hero\.subheading/)
  assert.match(String(gap), /b_hero\.ctaText/)
  assert.match(String(gap), /b_hero\.imageAlt/)
  // Non-translatable props should NOT appear
  assert.doesNotMatch(String(gap), /ctaHref/)
  assert.doesNotMatch(String(gap), /imageUrl/)
  assert.doesNotMatch(String(gap), /imagePosition/)
})

test("translation coverage: passes when all translatable Hero props covered", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero",
        type: "Hero" as const,
        props: {
          heading: "Build with confidence",
          subheading: "Make changes safely.",
          ctaText: "Get Started",
          ctaHref: "/",
          imageUrl: "/hero.svg",
          imageAlt: "Abstract illustration",
          imagePosition: "right"
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page to German",
      change_log: [],
      ops: [
        { op: "update_props", pageSlug: "/test", blockId: "b_hero", patch: {
          heading: "Mit Vertrauen bauen",
          subheading: "Änderungen sicher vornehmen.",
          ctaText: "Loslegen",
          imageAlt: "Abstrakte Illustration"
        } }
      ]
    },
    message: "translate this page to german",
    currentPage: page,
    slug: "/test"
  })
  assert.equal(gap, null)
})

test("translation coverage: skips non-translatable props (url, image, enum)", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero",
        type: "Hero" as const,
        props: {
          heading: "Hello",
          subheading: "World",
          ctaText: "Go",
          ctaHref: "/start",
          imageUrl: "/img.png",
          imageAlt: "Alt text",
          imagePosition: "left"
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
        { op: "update_props", pageSlug: "/test", blockId: "b_hero", patch: {
          heading: "Hallo",
          subheading: "Welt",
          ctaText: "Los",
          imageAlt: "Alternativtext"
        } }
      ]
    },
    message: "translate this page to german",
    currentPage: page,
    slug: "/test"
  })
  assert.equal(gap, null)
})

test("translation coverage: skips empty source props", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero",
        type: "Hero" as const,
        props: {
          heading: "Hello",
          subheading: "World",
          ctaText: "Go",
          ctaHref: "/",
          imageUrl: "/img.png",
          imageAlt: "Alt",
          imagePosition: "right",
          secondaryCtaText: undefined
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
        { op: "update_props", pageSlug: "/test", blockId: "b_hero", patch: {
          heading: "Hallo",
          subheading: "Welt",
          ctaText: "Los",
          imageAlt: "Alt-Text"
        } }
      ]
    },
    message: "translate this page to german",
    currentPage: page,
    slug: "/test"
  })
  // secondaryCtaText is undefined in source → not required
  assert.equal(gap, null)
})

test("translation coverage: CTA block missing title/description", () => {
  const page = {
    id: "p_test",
    slug: "/test",
    title: "Test",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_cta",
        type: "CTA" as const,
        props: {
          title: "Ready to start?",
          description: "Apply your next change.",
          ctaText: "Start now",
          ctaHref: "/"
        }
      }
    ]
  }
  const gap = findFullPageTranslationCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Translate page to German",
      change_log: [],
      ops: [
        { op: "update_props", pageSlug: "/test", blockId: "b_cta", patch: { ctaText: "Jetzt starten" } }
      ]
    },
    message: "translate this page to german",
    currentPage: page,
    slug: "/test"
  })
  assert.ok(gap)
  assert.match(String(gap), /b_cta\.title/)
  assert.match(String(gap), /b_cta\.description/)
})
