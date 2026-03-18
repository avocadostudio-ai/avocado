import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "FAQAccordion"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "FAQ Accordion")
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
    title: "FAQ",
    items: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects item with empty question`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "FAQ",
    items: [{ q: "", a: "Answer" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects item with empty answer`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "FAQ",
    items: [{ q: "Question?", a: "" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects wrong type for items (string instead of array)`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "FAQ",
    items: "not-an-array",
  })
  assert.equal(result.success, false)
})
