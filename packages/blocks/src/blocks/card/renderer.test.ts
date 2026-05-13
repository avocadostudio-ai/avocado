import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Card"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Card")
  assert.equal(meta.category, "content")
  assert.ok(meta.fields.title, "missing title field metadata")
  assert.ok(meta.fields.ctaText, "missing ctaText field metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "",
    description: "Some description",
    ctaText: "Click",
    ctaHref: "/",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema allows optional imageUrl`, () => {
  const withImage = validateBlockProps(BLOCK_TYPE, {
    title: "Title",
    description: "Desc",
    ctaText: "Click",
    ctaHref: "/",
    imageUrl: "/img.jpg",
    imageAlt: "Alt",
  })
  assert.equal(withImage.success, true)

  const withoutImage = validateBlockProps(BLOCK_TYPE, {
    title: "Title",
    description: "Desc",
    ctaText: "Click",
    ctaHref: "/",
  })
  assert.equal(withoutImage.success, true)
})

test(`${BLOCK_TYPE}: realistic full-props with Unsplash image`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Launch faster than ever",
    description: "Go from idea to published changes in minutes. Our AI-powered editor handles the heavy lifting so your team can focus on what matters.",
    ctaText: "Learn more",
    ctaHref: "/pricing",
    imageUrl: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=768&h=512&fit=crop",
    imageAlt: "Dashboard analytics view showing growth metrics",
  })
  assert.equal(result.success, true)
})
