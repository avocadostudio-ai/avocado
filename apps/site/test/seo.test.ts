import assert from "node:assert/strict"
import test from "node:test"
import type { PageDoc } from "../lib/site-contract"
import { derivePageDescription } from "../lib/seo.ts"

const basePage: PageDoc = {
  id: "p_test",
  slug: "/test",
  title: "Test Page",
  updatedAt: "2026-03-13T00:00:00.000Z",
  blocks: []
}

test("derivePageDescription prefers explicit metadata description", () => {
  const page: PageDoc = {
    ...basePage,
    meta: { description: "Explicit description for search snippets." }
  }

  assert.equal(derivePageDescription(page), "Explicit description for search snippets.")
})

test("derivePageDescription falls back to rich block text", () => {
  const page: PageDoc = {
    ...basePage,
    blocks: [
      {
        id: "b1",
        type: "Hero",
        props: {
          subheading: "Learn how to pick, store, and prepare avocados quickly for everyday meals."
        }
      }
    ]
  }

  const description = derivePageDescription(page)
  assert.match(description, /pick, store, and prepare avocados quickly/i)
})

test("derivePageDescription strips markdown and truncates long text", () => {
  const page: PageDoc = {
    ...basePage,
    blocks: [
      {
        id: "b2",
        type: "RichText",
        props: {
          body:
            "# Title\n\nThis is **a long markdown description** with [a link](https://example.com) that should be normalized and capped to a search-friendly length without weird symbols lingering around."
        }
      }
    ]
  }

  const description = derivePageDescription(page)
  assert.ok(description.length <= 161)
  assert.equal(description.includes("**"), false)
  assert.equal(description.includes("[a link]"), false)
})
