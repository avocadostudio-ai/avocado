import assert from "node:assert/strict"
import test from "node:test"

// The content resolution logic was consolidated into lib/content.ts.
// These tests verify the getPage/getNavSlugs behavior by importing directly.
// Since getPage/getNavSlugs depend on SDK fetch functions (which call process.env),
// we test the published path only (no network needed).

import { getPublishedPage, getPublishedSlugs } from "../lib/published-content-api.ts"

test("published content: getPublishedPage returns null for unknown slug", () => {
  assert.equal(getPublishedPage("/nonexistent"), null)
})

test("published content: getPublishedPage returns page for known slug", () => {
  const slugs = getPublishedSlugs()
  assert.ok(slugs.length > 0, "expected at least one published slug")
  const page = getPublishedPage(slugs[0])
  assert.ok(page)
  assert.equal(page.slug, slugs[0])
  assert.ok(Array.isArray(page.blocks))
})

test("published content: getPublishedSlugs returns non-empty array", () => {
  const slugs = getPublishedSlugs()
  assert.ok(slugs.length > 0)
  assert.ok(slugs.includes("/"), "expected home slug")
})
