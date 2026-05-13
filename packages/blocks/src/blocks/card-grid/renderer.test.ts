import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "CardGrid"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Card Grid")
  assert.equal(meta.category, "content")
  assert.ok(meta.listFields?.cards, "missing cards listField metadata")
})

test(`${BLOCK_TYPE}: default props pass schema validation`, () => {
  const props = defaultPropsForType(BLOCK_TYPE)
  const result = validateBlockProps(BLOCK_TYPE, props)
  assert.equal(result.success, true, `Schema validation failed: ${JSON.stringify(result.success ? null : result.error.issues)}`)
})

test(`${BLOCK_TYPE}: renderer is registered`, () => {
  assert.ok(renderers[BLOCK_TYPE], `No renderer found for ${BLOCK_TYPE}`)
  assert.equal(typeof renderers[BLOCK_TYPE], "function")
})

test(`${BLOCK_TYPE}: schema rejects empty cards array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Grid",
    cards: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects card with empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Grid",
    cards: [{ title: "", description: "Desc", ctaText: "Go", ctaHref: "/" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema allows optional subtitle`, () => {
  const withSub = validateBlockProps(BLOCK_TYPE, {
    title: "Grid",
    subtitle: "Sub",
    cards: [{ title: "Card", description: "Desc", ctaText: "Go", ctaHref: "/" }],
  })
  assert.equal(withSub.success, true)

  const withoutSub = validateBlockProps(BLOCK_TYPE, {
    title: "Grid",
    cards: [{ title: "Card", description: "Desc", ctaText: "Go", ctaHref: "/" }],
  })
  assert.equal(withoutSub.success, true)
})

test(`${BLOCK_TYPE}: realistic full-props with 3 diverse cards`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Why teams choose us",
    subtitle: "Everything you need to ship faster",
    cards: [
      {
        title: "Lightning-fast editing",
        description: "Make content changes in seconds with our AI-powered visual editor. No developer bottleneck.",
        ctaText: "See it in action",
        ctaHref: "/demo",
        imageUrl: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=768&h=512&fit=crop",
        imageAlt: "Dashboard showing real-time analytics",
      },
      {
        title: "Built for collaboration",
        description: "Your whole team can propose, review, and publish changes with role-based permissions.",
        ctaText: "Learn about teams",
        ctaHref: "/teams",
        imageUrl: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=768&h=512&fit=crop",
        imageAlt: "Team collaborating around a table",
      },
      {
        title: "Enterprise-grade security",
        description: "SOC 2 certified, SSO support, and audit logs included on every plan.",
        ctaText: "View security docs",
        ctaHref: "/security",
        imageUrl: "https://images.unsplash.com/photo-1563986768609-322da13575f2?w=768&h=512&fit=crop",
        imageAlt: "Lock icon on a server rack",
      },
    ],
  })
  assert.equal(result.success, true)
})
