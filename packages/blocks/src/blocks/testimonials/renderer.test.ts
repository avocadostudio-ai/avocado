import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Testimonials"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Testimonials")
  assert.equal(meta.category, "content")
  assert.ok(meta.listFields?.items, "missing items listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty items array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Testimonials",
    items: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "",
    items: [{ quote: "Great!", author: "Alex" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects item with empty quote`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Testimonials",
    items: [{ quote: "", author: "Alex" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects item with empty author`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Testimonials",
    items: [{ quote: "Great product!", author: "" }],
  })
  assert.equal(result.success, false)
})
