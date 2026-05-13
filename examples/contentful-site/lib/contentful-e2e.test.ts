/**
 * Contentful E2E tests — publish round-trip through the real Contentful API.
 *
 * Requires a Contentful space with the correct content model.
 * Skipped automatically when Contentful is unreachable.
 *
 * Run:
 *   CONTENTFUL_SPACE_ID=<space> \
 *   CONTENTFUL_MANAGEMENT_TOKEN=<token> \
 *   CONTENTFUL_DELIVERY_TOKEN=<token> \
 *   npx tsx --test examples/contentful-site/lib/contentful-e2e.test.ts
 */

import test, { describe, before, after } from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@avocadostudio-ai/shared"
import type { InlineAsset, PublishContext } from "@ai-site-editor/site-sdk/routes"

// ---------------------------------------------------------------------------
// Env / skip guard
// ---------------------------------------------------------------------------

const SPACE_ID = process.env.CONTENTFUL_SPACE_ID?.trim() ?? ""
const MGMT_TOKEN = process.env.CONTENTFUL_MANAGEMENT_TOKEN?.trim() ?? ""
const DELIVERY_TOKEN = process.env.CONTENTFUL_DELIVERY_TOKEN?.trim() ?? ""
const ENVIRONMENT = process.env.CONTENTFUL_ENVIRONMENT?.trim() || "master"

async function contentfulReachable(): Promise<boolean> {
  if (!SPACE_ID || !MGMT_TOKEN) return false
  try {
    const res = await fetch(
      `https://api.contentful.com/spaces/${SPACE_ID}/environments/${ENVIRONMENT}/entries?content_type=page&limit=1`,
      { headers: { Authorization: `Bearer ${MGMT_TOKEN}` }, signal: AbortSignal.timeout(5000) }
    )
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Contentful management helpers
// ---------------------------------------------------------------------------

async function cfFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(
    `https://api.contentful.com/spaces/${SPACE_ID}/environments/${ENVIRONMENT}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${MGMT_TOKEN}`,
        "Content-Type": "application/vnd.contentful.management.v1+json",
        ...options?.headers,
      },
    }
  )
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Contentful ${res.status}: ${body.slice(0, 300)}`)
  }
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

type CfEntry = { sys: { id: string; version: number; publishedVersion?: number }; fields: Record<string, unknown> }
type CfEntries = { items: CfEntry[] }

async function findPageEntry(slug: string): Promise<CfEntry | null> {
  const res = await cfFetch<CfEntries>(`/entries?content_type=page&fields.slug=${encodeURIComponent(slug)}&limit=1`)
  return res.items[0] ?? null
}

async function deleteEntry(id: string) {
  // Unpublish first if published
  try {
    const entry = await cfFetch<CfEntry>(`/entries/${id}`)
    if (entry.sys.publishedVersion) {
      await cfFetch(`/entries/${id}/published`, {
        method: "DELETE",
        headers: { "X-Contentful-Version": String(entry.sys.version) },
      })
    }
  } catch { /* ignore */ }
  try {
    const entry = await cfFetch<CfEntry>(`/entries/${id}`)
    await cfFetch(`/entries/${id}`, {
      method: "DELETE",
      headers: { "X-Contentful-Version": String(entry.sys.version) },
    })
  } catch { /* ignore */ }
}

async function deleteTestPage(slug: string) {
  const page = await findPageEntry(slug)
  if (!page) return
  // Delete block entries referenced by the page
  const blocksField = page.fields.blocks as Record<string, Array<{ sys: { id: string } }>> | undefined
  const blocks = blocksField?.["en-US"]
  if (Array.isArray(blocks)) {
    for (const ref of blocks) {
      if (ref?.sys?.id) await deleteEntry(ref.sys.id).catch(() => {})
    }
  }
  await deleteEntry(page.sys.id)
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SLUG = "/e2e-cf-image"
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="

function makePage(slug: string, title: string, blocks: PageDoc["blocks"]): PageDoc {
  return { id: `p_${slug.replace(/\//g, "_")}`, slug, title, updatedAt: new Date().toISOString(), blocks }
}

// ---------------------------------------------------------------------------
// Publish handler
// ---------------------------------------------------------------------------

let publish: (pages: PageDoc[], config: Record<string, unknown>, context?: PublishContext) => Promise<{ ok: boolean; error?: string }>

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contentful-e2e: image publish round-trip", { timeout: 60_000 }, () => {
  let skip = false
  let existingPages: PageDoc[] = []

  before(async () => {
    if (!(await contentfulReachable())) {
      skip = true
      return
    }
    const mod = await import("./publish.js")
    publish = mod.createContentfulPublishHandler({
      spaceId: SPACE_ID,
      managementToken: MGMT_TOKEN,
    })
    const fetchMod = await import("./contentful.js")
    existingPages = await fetchMod.getContentfulPages()
    await deleteTestPage(TEST_SLUG).catch(() => {})
  })

  after(async () => {
    if (skip) return
    await deleteTestPage(TEST_SLUG).catch(() => {})
  })

  // -----------------------------------------------------------------------
  // 1. Basic publish — page created with blocks
  // -----------------------------------------------------------------------
  test("publish creates a page with blocks in Contentful", async (t) => {
    if (skip) return t.skip("Contentful not reachable")

    const page = makePage(TEST_SLUG, "CF Image Test", [{
      id: "b_cta_cf",
      type: "CTA",
      props: {
        title: "Test CTA",
        description: "Contentful E2E",
        ctaText: "Go",
        ctaHref: "/",
      },
    }])

    const result = await publish([...existingPages, page], {})
    assert.ok(result.ok, `publish failed: ${result.error}`)

    const entry = await findPageEntry(TEST_SLUG)
    assert.ok(entry, "page not found in Contentful after publish")
    const slugField = entry.fields.slug as Record<string, string> | undefined
    assert.equal(slugField?.["en-US"], TEST_SLUG)
  })

  // -----------------------------------------------------------------------
  // 2. Inline asset — generated image uploaded to Contentful
  // -----------------------------------------------------------------------
  test("publish uploads inline asset (generated image) to Contentful", async (t) => {
    if (skip) return t.skip("Contentful not reachable")

    const localhostUrl = "http://localhost:4200/generated-images/e2e_cf_test.png"
    const page = makePage(TEST_SLUG, "CF Image Upload", [{
      id: "b_hero_cf_img",
      type: "Hero",
      props: {
        heading: "Image Upload",
        subheading: "Testing inline asset",
        ctaText: "Go",
        ctaHref: "/",
        imageUrl: localhostUrl,
        imageAlt: "CF E2E test image",
      },
    }])

    const result = await publish([...existingPages, page], {}, {
      assets: {
        [localhostUrl]: {
          data: TEST_PNG_BASE64,
          mimeType: "image/png",
          fileName: "e2e_cf_test.png",
        },
      },
    })
    assert.ok(result.ok, `publish failed: ${result.error}`)

    // Verify via fetch round-trip — the image should resolve to a URL
    const { getContentfulPage } = await import("./contentful.js")
    const fetched = await getContentfulPage(TEST_SLUG)
    assert.ok(fetched, "page not found via delivery API")
    const hero = fetched.blocks.find((b) => b.type === "Hero")
    assert.ok(hero, "Hero block missing")
    const imgUrl = hero.props.imageUrl as string
    assert.ok(imgUrl && imgUrl.length > 0, `imageUrl should be a non-empty string, got: ${JSON.stringify(imgUrl)}`)
    assert.ok(!imgUrl.includes("localhost"), "imageUrl should not contain localhost")
  })
})
