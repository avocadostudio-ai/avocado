import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@avocadostudio-ai/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "CTA"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Call to Action")
  assert.equal(meta.category, "conversion")
  assert.ok(meta.fields.title, "missing title field metadata")
  assert.ok(meta.fields.ctaText, "missing ctaText field metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty title`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "",
    description: "Desc",
    ctaText: "Go",
    ctaHref: "/",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects missing ctaHref`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Ready?",
    description: "Desc",
    ctaText: "Go",
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty description`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    title: "Ready to get started?",
    description: "",
    ctaText: "Sign up now",
    ctaHref: "/signup",
  })
  assert.equal(result.success, false)
})
