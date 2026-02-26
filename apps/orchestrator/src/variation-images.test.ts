import test from "node:test"
import assert from "node:assert/strict"
import { resolveDistinctUnsplashImage, type UnsplashImage, type UnsplashResolveOptions } from "./variation-images.js"

test("resolveDistinctUnsplashImage retries indices until URL is unique", async () => {
  const seen: number[] = []
  const used = new Set<string>(["https://images.example/cherries-a"])

  const resolveImage = async (_query: string, options?: UnsplashResolveOptions): Promise<UnsplashImage | null> => {
    const index = options?.variationIndex ?? 0
    seen.push(index)
    if (index < 2) {
      return {
        url: "https://images.example/cherries-a",
        alt: "Cherries A",
        query: "cherries"
      }
    }
    return {
      url: "https://images.example/cherries-b",
      alt: "Cherries B",
      query: "cherries"
    }
  }

  const out = await resolveDistinctUnsplashImage({
    query: "cherries",
    variationIndex: 0,
    usedImageUrls: used,
    resolveImage,
    maxAttempts: 5
  })

  assert.ok(out)
  assert.equal(out.url, "https://images.example/cherries-b")
  assert.deepEqual(seen, [0, 1, 2])
})

test("resolveDistinctUnsplashImage returns null after max attempts when all URLs are duplicates", async () => {
  const used = new Set<string>(["https://images.example/cherries-a"])
  const seen: number[] = []

  const resolveImage = async (_query: string, options?: UnsplashResolveOptions): Promise<UnsplashImage | null> => {
    seen.push(options?.variationIndex ?? 0)
    return {
      url: "https://images.example/cherries-a",
      alt: "Cherries A",
      query: "cherries"
    }
  }

  const out = await resolveDistinctUnsplashImage({
    query: "cherries",
    variationIndex: 1,
    usedImageUrls: used,
    resolveImage,
    maxAttempts: 3
  })

  assert.equal(out, null)
  assert.deepEqual(seen, [1, 2, 3])
})
