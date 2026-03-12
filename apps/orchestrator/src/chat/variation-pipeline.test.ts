import test from "node:test"
import assert from "node:assert/strict"
import {
  withDefaultImageVariations,
  setResolveUnsplashImageForTests,
  type VariationOption
} from "./variation-pipeline.js"
import type { PageDoc } from "@ai-site-editor/shared"

function heroBlock(): PageDoc["blocks"][number] {
  return {
    id: "b_hero",
    type: "Hero",
    props: {
      heading: "Fresh avocados",
      subheading: "Daily",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Hero image",
      ctaText: "Shop now",
      ctaHref: "/shop"
    }
  }
}

test("withDefaultImageVariations keeps images unique by default", async (t) => {
  const seenIndices: number[] = []
  setResolveUnsplashImageForTests(async (_query, options) => {
    const idx = options?.variationIndex ?? 0
    seenIndices.push(idx)
    if (idx < 2) {
      return { url: "https://images.example/shared.jpg", alt: "Shared", query: "avocado" }
    }
    return { url: `https://images.example/unique-${idx}.jpg`, alt: `Unique ${idx}`, query: "avocado" }
  })
  t.after(() => setResolveUnsplashImageForTests())

  const baseVariations: VariationOption[] = [
    { id: "a", title: "A", summary: "A", patch: { heading: "A heading" }, changedKeys: ["heading"] },
    { id: "b", title: "B", summary: "B", patch: { heading: "B heading" }, changedKeys: ["heading"] },
    { id: "c", title: "C", summary: "C", patch: { heading: "C heading" }, changedKeys: ["heading"] }
  ]

  const out = await withDefaultImageVariations({
    block: heroBlock(),
    message: "Generate 3 variations with Unsplash images",
    variations: baseVariations
  })

  assert.equal(out.length, 3)
  const urls = out.map((entry) => String(entry.patch.imageUrl))
  assert.equal(new Set(urls).size, 3)
  assert.ok(seenIndices.length > 3)
})

test("withDefaultImageVariations allows same image when explicitly requested", async (t) => {
  setResolveUnsplashImageForTests(async (_query, _options) => {
    return { url: "https://images.example/same.jpg", alt: "Same", query: "avocado" }
  })
  t.after(() => setResolveUnsplashImageForTests())

  const baseVariations: VariationOption[] = [
    { id: "a", title: "A", summary: "A", patch: { heading: "A heading" }, changedKeys: ["heading"] },
    { id: "b", title: "B", summary: "B", patch: { heading: "B heading" }, changedKeys: ["heading"] }
  ]

  const out = await withDefaultImageVariations({
    block: heroBlock(),
    message: "Generate 2 variations and keep the same image",
    variations: baseVariations
  })

  assert.equal(out.length, 2)
  const urls = out.map((entry) => String(entry.patch.imageUrl))
  assert.equal(new Set(urls).size, 1)
})
