import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Embed"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Embed")
  assert.equal(meta.category, "media")
  assert.ok(meta.fields.embedType, "missing embedType field metadata")
  assert.ok(meta.fields.url, "missing url field metadata")
  assert.ok(meta.fields.aspectRatio, "missing aspectRatio field metadata")
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
    embedType: "youtube",
    url: "",
    aspectRatio: "16:9",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all embed types`, () => {
  for (const embedType of ["youtube", "vimeo", "map", "custom"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      embedType,
      url: "https://example.com",
      aspectRatio: "16:9",
    })
    assert.equal(result.success, true, `Failed for embedType: ${embedType}`)
  }
})

test(`${BLOCK_TYPE}: schema accepts all aspect ratios`, () => {
  for (const aspectRatio of ["16:9", "4:3", "1:1"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      embedType: "youtube",
      url: "https://example.com",
      aspectRatio,
    })
    assert.equal(result.success, true, `Failed for aspectRatio: ${aspectRatio}`)
  }
})

test(`${BLOCK_TYPE}: schema rejects invalid embed type`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    embedType: "tiktok",
    url: "https://example.com",
    aspectRatio: "16:9",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema allows optional title`, () => {
  const withTitle = validateBlockProps(BLOCK_TYPE, {
    embedType: "youtube",
    url: "https://example.com",
    title: "My video",
    aspectRatio: "16:9",
  })
  assert.equal(withTitle.success, true)

  const withoutTitle = validateBlockProps(BLOCK_TYPE, {
    embedType: "youtube",
    url: "https://example.com",
    aspectRatio: "16:9",
  })
  assert.equal(withoutTitle.success, true)
})
