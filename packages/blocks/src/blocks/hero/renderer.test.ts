import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Hero"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Hero")
  assert.equal(meta.category, "content")
  assert.ok(meta.fields.heading, "missing heading field metadata")
  assert.ok(meta.fields.subheading, "missing subheading field metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty heading`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    heading: "",
    subheading: "Sub",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all imagePosition values`, () => {
  for (const imagePosition of ["left", "right"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      heading: "Hello",
      subheading: "World",
      ctaText: "Go",
      ctaHref: "/",
      imageUrl: "/img.jpg",
      imageAlt: "Alt",
      imagePosition,
    })
    assert.equal(result.success, true, `Failed for imagePosition: ${imagePosition}`)
  }
})

test(`${BLOCK_TYPE}: schema allows optional secondary CTA`, () => {
  const withSecondary = validateBlockProps(BLOCK_TYPE, {
    heading: "Hello",
    subheading: "World",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
    secondaryCtaText: "Learn more",
    secondaryCtaHref: "/about",
  })
  assert.equal(withSecondary.success, true)

  const withoutSecondary = validateBlockProps(BLOCK_TYPE, {
    heading: "Hello",
    subheading: "World",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
  })
  assert.equal(withoutSecondary.success, true)
})

test(`${BLOCK_TYPE}: schema rejects invalid imagePosition enum`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    heading: "Hello",
    subheading: "World",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
    imagePosition: "center",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects wrong type for heading (number)`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    heading: 42,
    subheading: "World",
    ctaText: "Go",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: realistic full-props with Unsplash URL and secondary CTA`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    heading: "Ship faster with AI-powered editing",
    subheading: "Go from idea to published changes in minutes — no code required. Our visual editor lets your whole team collaborate on content updates in real time.",
    ctaText: "Start free trial",
    ctaHref: "/pricing",
    imageUrl: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=1536&h=1024&fit=crop",
    imageAlt: "Team collaborating around a whiteboard in a modern office",
    imagePosition: "left",
    secondaryCtaText: "Watch 2-min demo",
    secondaryCtaHref: "/demo",
  })
  assert.equal(result.success, true)
})
