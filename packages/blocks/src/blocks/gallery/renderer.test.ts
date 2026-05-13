import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
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

test(`${BLOCK_TYPE}: realistic full-props with Unsplash gallery`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    images: [
      { imageUrl: "https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&h=600&fit=crop", caption: "Modern office space" },
      { imageUrl: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&h=600&fit=crop", caption: "Team brainstorm session" },
      { imageUrl: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&h=600&fit=crop", caption: "Analytics dashboard" },
      { imageUrl: "https://images.unsplash.com/photo-1563986768609-322da13575f2?w=800&h=600&fit=crop", caption: "Server infrastructure" },
    ],
    columns: "4",
  })
  assert.equal(result.success, true)
})
