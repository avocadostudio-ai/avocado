import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Stats"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Stats")
  assert.equal(meta.category, "content")
  assert.ok(meta.listFields?.stats, "missing stats listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty stats array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Stats",
    stats: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema allows optional title`, () => {
  const withTitle = validateBlockProps(BLOCK_TYPE, {
    title: "Numbers",
    stats: [{ value: "10k+", label: "Users" }],
  })
  assert.equal(withTitle.success, true)

  const withoutTitle = validateBlockProps(BLOCK_TYPE, {
    stats: [{ value: "10k+", label: "Users" }],
  })
  assert.equal(withoutTitle.success, true)
})

test(`${BLOCK_TYPE}: schema rejects stat with empty value`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    stats: [{ value: "", label: "Users" }],
  })
  assert.equal(result.success, false)
})
