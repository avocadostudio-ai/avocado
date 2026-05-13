import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "TwoColumn"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Two Column")
  assert.equal(meta.category, "layout")
  assert.ok(meta.listFields?.left, "missing left listField metadata")
  assert.ok(meta.listFields?.right, "missing right listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty left column`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    variant: "default",
    left: [],
    right: [{ type: "paragraph", text: "Hello" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty right column`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    variant: "default",
    left: [{ type: "heading", text: "Title" }],
    right: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all variant values`, () => {
  for (const variant of ["default", "accent"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      variant,
      left: [{ type: "heading", text: "Title" }],
      right: [{ type: "image", src: "/img.jpg", alt: "Alt" }],
    })
    assert.equal(result.success, true, `Failed for variant: ${variant}`)
  }
})

test(`${BLOCK_TYPE}: schema rejects invalid variant enum`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    variant: "dark",
    left: [{ type: "heading", text: "Title" }],
    right: [{ type: "paragraph", text: "Hello" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects invalid child type enum`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    variant: "default",
    left: [{ type: "blockquote", text: "Quote" }],
    right: [{ type: "paragraph", text: "Hello" }],
  })
  assert.equal(result.success, false)
})
