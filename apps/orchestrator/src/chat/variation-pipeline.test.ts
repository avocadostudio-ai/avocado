import test from "node:test"
import assert from "node:assert/strict"
import {
  withDefaultImageVariations,
  setResolveUnsplashImageForTests,
  setGenerateVariationImageForTests,
  requestedVariationCount,
  type VariationOption
} from "./variation-pipeline.js"
import type { PageDoc } from "@avocadostudio-ai/shared"

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

test("withDefaultImageVariations routes to AI gen when message mentions gemini", async (t) => {
  setResolveUnsplashImageForTests(async () => {
    throw new Error("should not call Unsplash when AI gen is selected")
  })
  let aiCallCount = 0
  setGenerateVariationImageForTests(async ({ altText }) => {
    aiCallCount++
    return { url: `https://ai.example/${aiCallCount}.png`, alt: altText, query: "ai" }
  })
  t.after(() => {
    setResolveUnsplashImageForTests()
    setGenerateVariationImageForTests()
  })

  const baseVariations: VariationOption[] = [
    { id: "a", title: "A", summary: "A", patch: { heading: "A" }, changedKeys: ["heading"] },
    { id: "b", title: "B", summary: "B", patch: { heading: "B" }, changedKeys: ["heading"] }
  ]

  const out = await withDefaultImageVariations({
    block: heroBlock(),
    message: "Generate 2 variations with gemini images",
    variations: baseVariations
  })

  assert.equal(out.length, 2)
  assert.equal(aiCallCount, 2)
  for (const entry of out) {
    assert.ok(String(entry.patch.imageUrl).startsWith("https://ai.example/"))
  }
})

test("withDefaultImageVariations honors VARIATION_DEFAULT_IMAGE_SOURCE=ai env default", async (t) => {
  const prev = process.env.VARIATION_DEFAULT_IMAGE_SOURCE
  process.env.VARIATION_DEFAULT_IMAGE_SOURCE = "ai"
  setResolveUnsplashImageForTests(async () => {
    throw new Error("should not call Unsplash when env default is ai")
  })
  let aiCallCount = 0
  setGenerateVariationImageForTests(async ({ altText }) => {
    aiCallCount++
    return { url: `https://ai.example/env-${aiCallCount}.png`, alt: altText, query: "ai" }
  })
  t.after(() => {
    if (prev === undefined) delete process.env.VARIATION_DEFAULT_IMAGE_SOURCE
    else process.env.VARIATION_DEFAULT_IMAGE_SOURCE = prev
    setResolveUnsplashImageForTests()
    setGenerateVariationImageForTests()
  })

  const baseVariations: VariationOption[] = [
    { id: "a", title: "A", summary: "A", patch: { heading: "A" }, changedKeys: ["heading"] },
    { id: "b", title: "B", summary: "B", patch: { heading: "B" }, changedKeys: ["heading"] }
  ]

  const out = await withDefaultImageVariations({
    block: heroBlock(),
    message: "Generate 2 variations of this banner",
    variations: baseVariations
  })

  assert.equal(out.length, 2)
  assert.equal(aiCallCount, 2)
})

test("requestedVariationCount parses numeric and word forms across synonyms", () => {
  assert.equal(requestedVariationCount("generate 5 variations"), 5)
  assert.equal(requestedVariationCount("show me 4 alternatives"), 4)
  assert.equal(requestedVariationCount("give 2 variants"), 2)
  assert.equal(requestedVariationCount("produce 6 options"), 6)
  assert.equal(requestedVariationCount("draft three alternatives"), 3)
  assert.equal(requestedVariationCount("show seven variants"), 7)
  assert.equal(requestedVariationCount("generate variations"), 3)
  assert.equal(requestedVariationCount("generate 99 variations"), 12)
})

test("withDefaultImageVariations strips LLM-authored imageUrl when unsplash resolution fails", async (t) => {
  // Simulate Unsplash resolution returning null (e.g. rate limit / no match)
  // for every variation. The LLM had authored fake imageUrl values that must
  // NOT leak through into the final patch — otherwise the preview shows a
  // broken image with only the LLM-authored alt text visible.
  setResolveUnsplashImageForTests(async () => null)
  t.after(() => setResolveUnsplashImageForTests())

  const baseVariations: VariationOption[] = [
    {
      id: "a",
      title: "A",
      summary: "A",
      patch: {
        heading: "A heading",
        imageUrl: "https://images.unsplash.com/fake-hallucinated-by-llm-a",
        imageAlt: "LLM-described scene A"
      },
      changedKeys: ["heading", "imageUrl", "imageAlt"]
    },
    {
      id: "b",
      title: "B",
      summary: "B",
      patch: {
        heading: "B heading",
        imageUrl: "https://images.unsplash.com/fake-hallucinated-by-llm-b",
        imageAlt: "LLM-described scene B"
      },
      changedKeys: ["heading", "imageUrl", "imageAlt"]
    }
  ]

  const out = await withDefaultImageVariations({
    block: heroBlock(),
    message: "Generate 2 variations with various images using unsplash",
    variations: baseVariations
  })

  assert.equal(out.length, 2)
  for (const entry of out) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(entry.patch, "imageUrl"),
      "imageUrl must be stripped when resolution fails"
    )
    assert.ok(
      !Object.prototype.hasOwnProperty.call(entry.patch, "imageAlt"),
      "imageAlt must also be stripped when no real image is resolved"
    )
    assert.equal(typeof entry.patch.heading, "string")
  }
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
