import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Embed"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Embed")
  assert.equal(meta.category, "media")
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

test(`${BLOCK_TYPE}: schema rejects empty url`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    embedType: "map",
    url: "",
    aspectRatio: "16:9",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all embed types`, () => {
  for (const embedType of ["map", "social", "custom"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      embedType,
      url: "https://example.com",
      aspectRatio: "16:9",
    })
    assert.equal(result.success, true, `Failed for embedType: ${embedType}`)
  }
})

test(`${BLOCK_TYPE}: schema rejects youtube as embed type`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    embedType: "youtube",
    url: "https://example.com",
    aspectRatio: "16:9",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all aspect ratios`, () => {
  for (const aspectRatio of ["16:9", "4:3", "1:1"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      embedType: "map",
      url: "https://example.com",
      aspectRatio,
    })
    assert.equal(result.success, true, `Failed for aspectRatio: ${aspectRatio}`)
  }
})
