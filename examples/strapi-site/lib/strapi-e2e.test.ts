/**
 * Strapi E2E tests — publish round-trip through the real Strapi API.
 *
 * Requires a running Strapi instance at STRAPI_URL with a valid STRAPI_API_TOKEN.
 * Skipped automatically when Strapi is unreachable.
 *
 * Run:
 *   STRAPI_URL=http://localhost:1337 \
 *   STRAPI_API_TOKEN=<token> \
 *   npx tsx --test examples/strapi-site/lib/strapi-e2e.test.ts
 */

import test, { describe, before, after } from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@ai-site-editor/shared"

// ---------------------------------------------------------------------------
// Env / skip guard
// ---------------------------------------------------------------------------

const STRAPI_URL = process.env.STRAPI_URL?.trim().replace(/\/+$/, "") ?? "http://localhost:1337"
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN?.trim() ?? ""

async function strapiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${STRAPI_URL}/api/pages?pagination[pageSize]=1`, {
      headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Strapi REST helpers (self-contained, no import of strapi.client to avoid
// the top-level throw when STRAPI_URL is missing in CI)
// ---------------------------------------------------------------------------

async function strapiFetch<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${STRAPI_URL}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Strapi ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

type StrapiItem = { id: number; documentId: string; slug?: string; [k: string]: unknown }
type StrapiList<T> = { data: T[] }

async function listStrapiSlugs(): Promise<string[]> {
  const res = await strapiFetch<StrapiList<StrapiItem>>("/pages?fields[0]=slug&pagination[pageSize]=100")
  return res.data.map((d) => d.slug as string).filter(Boolean)
}

async function findStrapiPage(slug: string): Promise<StrapiItem | null> {
  const res = await strapiFetch<StrapiList<StrapiItem>>(
    `/pages?filters[slug][$eq]=${encodeURIComponent(slug)}&populate[blocks][populate]=*`
  )
  return res.data[0] ?? null
}

async function deleteStrapiPage(slug: string) {
  const page = await findStrapiPage(slug)
  if (page) await strapiFetch(`/pages/${page.documentId}`, { method: "DELETE" })
}

// ---------------------------------------------------------------------------
// Publish handler under test
// ---------------------------------------------------------------------------

// Dynamically import to avoid top-level STRAPI_URL throw when env is missing
let publish: (pages: PageDoc[], config: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const TEST_SLUG_HOME = "/"
const TEST_SLUG_ABOUT = "/e2e-about"
const TEST_SLUG_CONTACT = "/e2e-contact"

function makePage(slug: string, title: string, blocks: PageDoc["blocks"] = []): PageDoc {
  return {
    id: `p_${title.toLowerCase().replace(/\s+/g, "_")}`,
    slug,
    title,
    updatedAt: new Date().toISOString(),
    blocks,
  }
}

function heroBlock(id: string, heading: string): PageDoc["blocks"][number] {
  return {
    id,
    type: "Hero",
    props: {
      heading,
      subheading: "E2E test subheading",
      ctaText: "Click",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Test hero image",
    },
  }
}

function ctaBlock(id: string, title: string): PageDoc["blocks"][number] {
  return {
    id,
    type: "CTA",
    props: {
      title,
      description: "E2E CTA description",
      ctaText: "Go",
      ctaHref: "/",
    },
  }
}

describe("strapi-e2e: publish round-trip", { timeout: 30_000 }, () => {
  let skip = false

  /** Existing CMS pages captured before tests run — always included in publish calls
   *  so the delete-sync logic doesn't wipe real content. */
  let existingPages: PageDoc[] = []

  before(async () => {
    if (!(await strapiReachable())) {
      skip = true
      return
    }
    // Dynamic import so STRAPI_URL env is set before module loads
    const mod = await import("./publish.js")
    const fetchMod = await import("./strapi.fetch.js")
    publish = mod.createStrapiPublishHandler()

    // Capture existing pages so we never delete them during test publishes
    existingPages = await fetchMod.getStrapiPages()

    // Clean up test pages from previous runs
    for (const slug of [TEST_SLUG_ABOUT, TEST_SLUG_CONTACT]) {
      await deleteStrapiPage(slug).catch(() => {})
    }
  })

  after(async () => {
    if (skip) return
    for (const slug of [TEST_SLUG_ABOUT, TEST_SLUG_CONTACT]) {
      await deleteStrapiPage(slug).catch(() => {})
    }
  })

  // -----------------------------------------------------------------------
  // 1. Create page → verify it lands in Strapi
  // -----------------------------------------------------------------------
  test("publish creates a new page in Strapi", async (t) => {
    if (skip) return t.skip("Strapi not reachable")

    const page = makePage(TEST_SLUG_ABOUT, "E2E About", [
      heroBlock("b_hero_about", "About Us"),
      ctaBlock("b_cta_about", "Get in touch"),
    ])

    const result = await publish([...existingPages, page], {})
    assert.ok(result.ok, `publish failed: ${result.error}`)

    const cms = await findStrapiPage(TEST_SLUG_ABOUT)
    assert.ok(cms, "page not found in Strapi after publish")
    assert.equal(cms.slug, TEST_SLUG_ABOUT)

    // Verify blocks came through as Dynamic Zone components
    const blocks = cms.blocks as Array<{ __component: string; heading?: string; title?: string }>
    assert.ok(Array.isArray(blocks) && blocks.length === 2, `expected 2 blocks, got ${blocks?.length}`)
    assert.equal(blocks[0].__component, "blocks.hero")
    assert.equal(blocks[0].heading, "About Us")
    assert.equal(blocks[1].__component, "blocks.cta")
    assert.equal(blocks[1].title, "Get in touch")
  })

  // -----------------------------------------------------------------------
  // 2. Update page props → verify change persists in Strapi
  // -----------------------------------------------------------------------
  test("publish updates existing page props in Strapi", async (t) => {
    if (skip) return t.skip("Strapi not reachable")

    const page = makePage(TEST_SLUG_ABOUT, "E2E About Updated", [
      heroBlock("b_hero_about", "About Us — Revised"),
      ctaBlock("b_cta_about", "Contact us now"),
    ])

    const result = await publish([...existingPages, page], {})
    assert.ok(result.ok, `publish failed: ${result.error}`)

    const cms = await findStrapiPage(TEST_SLUG_ABOUT)
    assert.ok(cms, "page missing after update publish")
    assert.equal(cms.title, "E2E About Updated")

    const blocks = cms.blocks as Array<{ __component: string; heading?: string; title?: string }>
    assert.equal(blocks[0].heading, "About Us — Revised")
    assert.equal(blocks[1].title, "Contact us now")
  })

  // -----------------------------------------------------------------------
  // 3. Delete page → publish without it → verify gone from Strapi
  // -----------------------------------------------------------------------
  test("publish deletes pages removed from the session", async (t) => {
    if (skip) return t.skip("Strapi not reachable")

    // First ensure two test pages exist
    const about = makePage(TEST_SLUG_ABOUT, "E2E About", [heroBlock("b_hero_about", "About")])
    const contact = makePage(TEST_SLUG_CONTACT, "E2E Contact", [ctaBlock("b_cta_contact", "Contact")])
    const r1 = await publish([...existingPages, about, contact], {})
    assert.ok(r1.ok, `setup publish failed: ${r1.error}`)

    const slugsBefore = await listStrapiSlugs()
    assert.ok(slugsBefore.includes(TEST_SLUG_ABOUT), "about should exist before delete")
    assert.ok(slugsBefore.includes(TEST_SLUG_CONTACT), "contact should exist before delete")

    // Now publish without about — it should be deleted
    const r2 = await publish([...existingPages, contact], {})
    assert.ok(r2.ok, `delete publish failed: ${r2.error}`)

    const slugsAfter = await listStrapiSlugs()
    assert.ok(!slugsAfter.includes(TEST_SLUG_ABOUT), "about should be gone after publish without it")
    assert.ok(slugsAfter.includes(TEST_SLUG_CONTACT), "contact should still exist")
  })

  // -----------------------------------------------------------------------
  // 4. Fetch round-trip: publish → fetch back → verify block data intact
  // -----------------------------------------------------------------------
  test("fetch round-trip: published blocks survive Strapi read-back", async (t) => {
    if (skip) return t.skip("Strapi not reachable")

    const page = makePage(TEST_SLUG_ABOUT, "Round-trip Test", [
      heroBlock("b_hero_rt", "Round-trip Hero"),
      ctaBlock("b_cta_rt", "Round-trip CTA"),
    ])

    const r = await publish([...existingPages, page], {})
    assert.ok(r.ok, `publish failed: ${r.error}`)

    // Use the fetch functions to read back (same code path as the site)
    const { getStrapiPage } = await import("./strapi.fetch.js")
    const fetched = await getStrapiPage(TEST_SLUG_ABOUT)
    assert.ok(fetched, "getStrapiPage returned null after publish")
    assert.equal(fetched.title, "Round-trip Test")
    assert.equal(fetched.blocks.length, 2)
    assert.equal(fetched.blocks[0].type, "Hero")
    assert.equal(fetched.blocks[0].props.heading, "Round-trip Hero")
    assert.equal(fetched.blocks[1].type, "CTA")
    assert.equal(fetched.blocks[1].props.title, "Round-trip CTA")
  })
})
