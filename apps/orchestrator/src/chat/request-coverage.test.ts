import test from "node:test"
import assert from "node:assert/strict"
import { findExplicitCtaTargetCoverageGap } from "./chat-pipeline.js"

const message =
  "Rewrite both CTA labels on this page so they are consistent and action-oriented: hero CTA should invite exploring, footer CTA should invite joining. Keep all links unchanged and avoid exclamation marks."

function makePage() {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero_home",
        type: "Hero" as const,
        props: {
          heading: "Heading",
          subheading: "Subheading",
          ctaText: "Get Started",
          ctaHref: "/",
          imageUrl: "/hero-generated.svg",
          imageAlt: "Hero"
        }
      },
      {
        id: "b_cta_home",
        type: "CTA" as const,
        props: {
          title: "Join",
          description: "Desc",
          ctaText: "Get Started",
          ctaHref: "/signup"
        }
      }
    ]
  }
}

test("explicit CTA coverage: flags missing hero/footer target update", () => {
  const page = makePage()
  const gap = findExplicitCtaTargetCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Update CTA text.",
      change_log: [],
      ops: [{ op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { ctaText: "Explore more" } }]
    },
    message,
    currentPage: page,
    slug: "/"
  })
  assert.ok(gap)
  assert.match(String(gap), /footer cta text/i)
})

test("explicit CTA coverage: passes when both CTA targets are updated and links are unchanged", () => {
  const page = makePage()
  const gap = findExplicitCtaTargetCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Update CTA text.",
      change_log: [],
      ops: [
        { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { ctaText: "Explore options" } },
        { op: "update_props", pageSlug: "/", blockId: "b_cta_home", patch: { ctaText: "Join today" } }
      ]
    },
    message,
    currentPage: page,
    slug: "/"
  })
  assert.equal(gap, null)
})

test("explicit CTA coverage: flags link updates when links must remain unchanged", () => {
  const page = makePage()
  const gap = findExplicitCtaTargetCoverageGap({
    plan: {
      intent: "edit_plan",
      summary_for_user: "Update CTA text.",
      change_log: [],
      ops: [
        { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { ctaText: "Explore options", ctaHref: "/new" } },
        { op: "update_props", pageSlug: "/", blockId: "b_cta_home", patch: { ctaText: "Join today" } }
      ]
    },
    message,
    currentPage: page,
    slug: "/"
  })
  assert.ok(gap)
  assert.match(String(gap), /links unchanged/i)
})
