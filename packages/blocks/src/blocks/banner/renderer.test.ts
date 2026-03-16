import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "Banner"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Banner")
  assert.equal(meta.category, "content")
  assert.ok(meta.fields.text, "missing text field metadata")
  assert.ok(meta.fields.variant, "missing variant field metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty text`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    text: "",
    variant: "info",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema accepts all variants`, () => {
  for (const variant of ["info", "success", "warning"]) {
    const result = validateBlockProps(BLOCK_TYPE, {
      text: "Hello",
      variant,
    })
    assert.equal(result.success, true, `Failed for variant: ${variant}`)
  }
})

test(`${BLOCK_TYPE}: schema rejects invalid variant`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    text: "Hello",
    variant: "danger",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema allows optional ctaText and ctaHref`, () => {
  const withCta = validateBlockProps(BLOCK_TYPE, {
    text: "Hello",
    variant: "info",
    ctaText: "Click me",
    ctaHref: "/page",
  })
  assert.equal(withCta.success, true)

  const withoutCta = validateBlockProps(BLOCK_TYPE, {
    text: "Hello",
    variant: "info",
  })
  assert.equal(withoutCta.success, true)
})
