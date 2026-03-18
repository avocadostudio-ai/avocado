import test from "node:test"
import assert from "node:assert/strict"
import { validateBlockProps, getBlockMeta, defaultPropsForType } from "@ai-site-editor/shared"
import { renderers } from "../index"

const BLOCK_TYPE = "SiteHeader"

test(`${BLOCK_TYPE}: registered in block registry`, () => {
  const meta = getBlockMeta(BLOCK_TYPE)
  assert.ok(meta, `${BLOCK_TYPE} not found in registry`)
  assert.equal(meta.displayName, "Site Header")
  assert.equal(meta.category, "navigation")
  assert.equal(meta.chrome, true)
  assert.ok(meta.listFields?.links, "missing links listField metadata")
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

test(`${BLOCK_TYPE}: schema rejects empty links array`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    siteName: "My Site",
    logoUrl: "/logo.svg",
    links: [],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects empty siteName`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    siteName: "",
    logoUrl: "/logo.svg",
    links: [{ label: "Home", href: "/" }],
  })
  assert.equal(result.success, false)
})

test(`${BLOCK_TYPE}: schema rejects link with empty label`, () => {
  const result = validateBlockProps(BLOCK_TYPE, {
    siteName: "My Site",
    logoUrl: "/logo.svg",
    links: [{ label: "", href: "/" }],
  })
  assert.equal(result.success, false)
})
