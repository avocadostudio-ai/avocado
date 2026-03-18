import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "FeatureGrid"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Feature Grid")
  assert.equal(meta.category, "content")
  assert.ok(meta.listFields?.features, "missing features listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty features array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Features",
    features: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects feature with empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Features",
    features: [{ title: "", description: "Desc" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects feature with empty description`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Features",
    features: [{ title: "Speed", description: "" }],
  })
  assert.equal(result.success, false)
})
