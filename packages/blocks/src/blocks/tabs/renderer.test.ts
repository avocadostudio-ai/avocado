import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Tabs"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Tabs")
  assert.equal(meta.category, "content")
  assert.ok(meta.listFields?.tabs, "missing tabs listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty tabs array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, { tabs: [] })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects tab with empty label`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    tabs: [{ label: "", content: "Some content" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects tab with empty content`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    tabs: [{ label: "Tab 1", content: "" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts valid single tab`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    tabs: [{ label: "Tab 1", content: "Hello world" }],
  })
  assert.equal(result.success, true)
})
