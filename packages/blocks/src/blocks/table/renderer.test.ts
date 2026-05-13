import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Table"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Table")
  assert.equal(meta.category, "content")
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

test(`${BLOCK_TYPE}: schema rejects empty headers`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    headers: [],
    rows: [["a"]],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty rows`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    headers: ["Col"],
    rows: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts valid table`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    headers: ["A", "B"],
    rows: [["1", "2"], ["3", "4"]],
  })
  assert.equal(result.success, true)
})

test(`${BLOCK_TYPE}: schema accepts striped variants`, () => {
  for (const striped of ["true", "false"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      headers: ["A"],
      rows: [["1"]],
      striped,
    })
    assert.equal(result.success, true, `Failed for striped: ${striped}`)
  }
})
