import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Gallery"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Gallery")
  assert.equal(meta.category, "media")
  assert.ok(meta.listFields?.images, "missing images listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty images array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, { images: [], columns: "3" })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects image with empty imageUrl`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    images: [{ imageUrl: "" }],
    columns: "3",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all column values`, () => {
  for (const columns of ["2", "3", "4"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      images: [{ imageUrl: "/img.jpg" }],
      columns,
    })
    assert.equal(result.success, true, `Failed for columns: ${columns}`)
  }
})

test(`${BLOCK_TYPE}: schema rejects invalid columns value`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    images: [{ imageUrl: "/img.jpg" }],
    columns: "5",
  })
  assert.equal(result.success, false)
})
