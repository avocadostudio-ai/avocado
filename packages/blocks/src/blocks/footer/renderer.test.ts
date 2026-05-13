import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Footer"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Footer")
  assert.equal(meta.category, "navigation")
  assert.equal(meta.chrome, true)
  assert.ok(meta.listFields?.columns, "missing columns listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty columns array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    copyright: "© 2026",
    columns: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty copyright`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    copyright: "",
    columns: [{ title: "Product", links: "Home|/" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects column with empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    copyright: "© 2026",
    columns: [{ title: "", links: "Home|/" }],
  })
  assert.equal(result.success, false)
})
