import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Video"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Video")
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

test(`${BLOCK_TYPE}: schema rejects empty src`, () => {
  const result = validateBlockProps(BLOCK_TYPE, { src: "" })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts YouTube URL`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    src: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  })
  assert.equal(result.success, true)
})

test(`${BLOCK_TYPE}: schema accepts direct video URL`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    src: "https://example.com/video.mp4",
  })
  assert.equal(result.success, true)
})

test(`${BLOCK_TYPE}: schema accepts all optional fields`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    src: "https://vimeo.com/123456",
    title: "My video",
    posterUrl: "/poster.jpg",
    autoplay: "true",
    loop: "true",
  })
  assert.equal(result.success, true)
})
