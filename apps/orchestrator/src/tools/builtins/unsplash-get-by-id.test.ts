import test from "node:test"
import assert from "node:assert/strict"
import { extractUnsplashPhotoId, unsplashGetByIdHandler, unsplashGetByIdManifest } from "./unsplash-get-by-id.js"
import type { ToolCallContext } from "../types.js"

function makeContext(): ToolCallContext {
  return { siteId: "t", sessionId: "s", traceId: "r", plannerProvider: "anthropic" }
}

test("extractUnsplashPhotoId handles slug-with-id URL", () => {
  const id = extractUnsplashPhotoId("https://unsplash.com/photos/an-aerial-view-of-lava-in-the-ocean-4c0JJqaG93c")
  assert.equal(id, "4c0JJqaG93c")
})

test("extractUnsplashPhotoId handles bare-id URL", () => {
  const id = extractUnsplashPhotoId("https://unsplash.com/photos/4c0JJqaG93c")
  assert.equal(id, "4c0JJqaG93c")
})

test("extractUnsplashPhotoId ignores query string", () => {
  const id = extractUnsplashPhotoId("https://unsplash.com/photos/foo-bar-4c0JJqaG93c?ixid=abc&t=1")
  assert.equal(id, "4c0JJqaG93c")
})

test("extractUnsplashPhotoId tolerates www. + trailing slash", () => {
  const id = extractUnsplashPhotoId("https://www.unsplash.com/photos/foo-4c0JJqaG93c/")
  assert.equal(id, "4c0JJqaG93c")
})

test("extractUnsplashPhotoId accepts bare ID input", () => {
  assert.equal(extractUnsplashPhotoId("4c0JJqaG93c"), "4c0JJqaG93c")
})

test("extractUnsplashPhotoId rejects non-Unsplash hosts", () => {
  assert.equal(extractUnsplashPhotoId("https://example.com/photos/foo-abcdef"), null)
})

test("extractUnsplashPhotoId rejects URLs without /photos/<slug>", () => {
  assert.equal(extractUnsplashPhotoId("https://unsplash.com/s/photos/lava"), null)
  assert.equal(extractUnsplashPhotoId("https://unsplash.com/photos"), null)
})

test("extractUnsplashPhotoId rejects ids that are too short", () => {
  // final token after last hyphen must be >=6 alphanumeric/underscore/hyphen chars
  assert.equal(extractUnsplashPhotoId("https://unsplash.com/photos/foo-bar"), null)
})

test("unsplashGetByIdHandler throws when no url or id supplied", async () => {
  await assert.rejects(
    unsplashGetByIdHandler({ input: {}, context: makeContext(), manifest: unsplashGetByIdManifest }),
    /Could not extract an Unsplash photo ID/
  )
})

test("unsplashGetByIdHandler throws when access key is missing", async () => {
  const prior = process.env.UNSPLASH_ACCESS_KEY
  delete process.env.UNSPLASH_ACCESS_KEY
  try {
    await assert.rejects(
      unsplashGetByIdHandler({
        input: { url: "https://unsplash.com/photos/foo-4c0JJqaG93c" },
        context: makeContext(),
        manifest: unsplashGetByIdManifest,
      }),
      /UNSPLASH_ACCESS_KEY is not configured/
    )
  } finally {
    if (prior) process.env.UNSPLASH_ACCESS_KEY = prior
  }
})

test("unsplashGetByIdHandler hits the API and maps the response", async () => {
  const prior = process.env.UNSPLASH_ACCESS_KEY
  process.env.UNSPLASH_ACCESS_KEY = "test-key"

  const originalFetch = global.fetch
  let calledUrl = ""
  let calledAuth = ""
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calledUrl = String(url)
    calledAuth = (init?.headers as Record<string, string>)?.Authorization ?? ""
    return new Response(
      JSON.stringify({
        urls: { regular: "https://images.unsplash.com/photo-abc" },
        alt_description: "  aerial view of lava  ",
        user: { name: "Jane Doe" },
        links: { html: "https://unsplash.com/photos/foo-4c0JJqaG93c" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }) as typeof fetch

  try {
    const result = await unsplashGetByIdHandler({
      input: { url: "https://unsplash.com/photos/an-aerial-view-4c0JJqaG93c" },
      context: makeContext(),
      manifest: unsplashGetByIdManifest,
    }) as Record<string, string>

    assert.equal(calledUrl, "https://api.unsplash.com/photos/4c0JJqaG93c")
    assert.equal(calledAuth, "Client-ID test-key")
    assert.equal(result.photoId, "4c0JJqaG93c")
    assert.equal(result.author, "Jane Doe")
    assert.equal(result.alt, "aerial view of lava")
    // Transform params appended
    assert.match(result.imageUrl, /images\.unsplash\.com\/photo-abc\?auto=format/)
  } finally {
    global.fetch = originalFetch
    if (prior) process.env.UNSPLASH_ACCESS_KEY = prior
    else delete process.env.UNSPLASH_ACCESS_KEY
  }
})
