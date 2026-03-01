import test from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sessionCounter = 0
function newSession() {
  return `apply-ops-test-${++sessionCounter}`
}

type OpsPayload = { session: string; ops: unknown[] }

async function postOps(payload: OpsPayload) {
  return app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })
}

async function getPage(session: string, slug: string) {
  return app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent(slug)}`
  })
}

async function getSlugs(session: string) {
  const res = await app.inject({
    method: "GET",
    url: `/draft/slugs?session=${encodeURIComponent(session)}`
  })
  return JSON.parse(res.body) as { slugs: string[] }
}

// ---------------------------------------------------------------------------
// Happy-path: page-level ops
// ---------------------------------------------------------------------------

test("create_page: new page appears in draft with correct slug and title", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "create_page",
        page: {
          id: "p_new_about",
          slug: "/about",
          title: "About Us",
          updatedAt: new Date().toISOString(),
          blocks: []
        }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const { slugs } = await getSlugs(session)
  assert.ok(slugs.includes("/about"), "new page slug should appear in draft")

  const pageRes = await getPage(session, "/about")
  assert.equal(pageRes.statusCode, 200)
  const page = JSON.parse(pageRes.body)
  assert.equal(page.slug, "/about")
  assert.equal(page.title, "About Us")
})

test("rename_page: old slug gone, new slug present, title updated", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "rename_page",
        pageSlug: "/pricing",
        newPageSlug: "/plans",
        newTitle: "Our Plans"
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const { slugs } = await getSlugs(session)
  assert.ok(!slugs.includes("/pricing"), "old slug should be gone")
  assert.ok(slugs.includes("/plans"), "new slug should be present")

  const pageRes = await getPage(session, "/plans")
  assert.equal(pageRes.statusCode, 200)
  const page = JSON.parse(pageRes.body)
  assert.equal(page.slug, "/plans")
  assert.equal(page.title, "Our Plans")
})

test("rename_page: href links to old slug are rewritten on other pages", async () => {
  const session = newSession()
  // The demo home page CTA block links to /pricing — rename /pricing to /plans
  // and confirm the link is rewritten.
  const res = await postOps({
    session,
    ops: [{ op: "rename_page", pageSlug: "/pricing", newPageSlug: "/plans" }]
  })
  assert.equal(res.statusCode, 200)

  const homeRes = await getPage(session, "/")
  const home = JSON.parse(homeRes.body)
  const ctaBlock = home.blocks.find((b: { id: string }) => b.id === "b_cta_home")
  assert.ok(ctaBlock, "CTA block should still exist on home page")
  assert.equal(ctaBlock.props.ctaHref, "/plans", "ctaHref should be rewritten from /pricing to /plans")
})

test("remove_page: slug deleted from draft", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "remove_page", pageSlug: "/pricing" }]
  })
  assert.equal(res.statusCode, 200)
  const { slugs } = await getSlugs(session)
  assert.ok(!slugs.includes("/pricing"), "removed page should be gone")
})

test("move_page: nav order changes when afterPageSlug is given", async () => {
  // First create a third page so we have something meaningful to reorder.
  const session = newSession()
  await postOps({
    session,
    ops: [
      {
        op: "create_page",
        page: { id: "p_contact", slug: "/contact", title: "Contact", updatedAt: new Date().toISOString(), blocks: [] }
      }
    ]
  })
  // Move /pricing after /contact (i.e. to the end)
  const res = await postOps({
    session,
    ops: [{ op: "move_page", pageSlug: "/pricing", afterPageSlug: "/contact" }]
  })
  assert.equal(res.statusCode, 200)
  const { slugs } = await getSlugs(session)
  const pricingIdx = slugs.indexOf("/pricing")
  const contactIdx = slugs.indexOf("/contact")
  assert.ok(pricingIdx > contactIdx, "/pricing should come after /contact")
  assert.equal(slugs[0], "/", "home should always be first")
})

test("duplicate_page: copy exists with new slug, all block ids are unique", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "duplicate_page", pageSlug: "/pricing", newPageSlug: "/pricing-v2", newTitle: "Pricing V2" }]
  })
  assert.equal(res.statusCode, 200)
  const { slugs } = await getSlugs(session)
  assert.ok(slugs.includes("/pricing"), "original page should remain")
  assert.ok(slugs.includes("/pricing-v2"), "duplicate should exist")

  const origRes = await getPage(session, "/pricing")
  const orig = JSON.parse(origRes.body)
  const copyRes = await getPage(session, "/pricing-v2")
  const copy = JSON.parse(copyRes.body)

  assert.equal(copy.title, "Pricing V2")
  assert.equal(copy.blocks.length, orig.blocks.length)
  // All block ids must be unique across both pages
  const origIds = new Set(orig.blocks.map((b: { id: string }) => b.id))
  for (const block of copy.blocks) {
    assert.ok(!origIds.has(block.id), `copy block id ${block.id} must differ from original`)
  }
})

// ---------------------------------------------------------------------------
// Happy-path: block-level ops
// ---------------------------------------------------------------------------

test("add_block: block appended to end of page", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_cta_new",
          type: "CTA",
          props: {
            title: "Try it now",
            description: "Sign up for free.",
            ctaText: "Get started",
            ctaHref: "/pricing"
          }
        }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const block = page.blocks.find((b: { id: string }) => b.id === "b_cta_new")
  assert.ok(block, "new block should exist on the page")
  assert.equal(page.blocks[page.blocks.length - 1].id, "b_cta_new", "block should be appended to end")
})

test("add_block: block inserted after a specific block", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        afterBlockId: "b_hero_home",
        block: {
          id: "b_card_mid",
          type: "Card",
          props: { title: "Card", description: "A card.", ctaText: "Learn more", ctaHref: "/" }
        }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const heroIdx = page.blocks.findIndex((b: { id: string }) => b.id === "b_hero_home")
  const cardIdx = page.blocks.findIndex((b: { id: string }) => b.id === "b_card_mid")
  assert.equal(cardIdx, heroIdx + 1, "card should be directly after hero")
})

test("update_props: patch applied to Hero heading", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { heading: "Welcome to the future" }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const hero = page.blocks.find((b: { id: string }) => b.id === "b_hero_home")
  assert.equal(hero.props.heading, "Welcome to the future")
})

test("remove_block: block is gone from page", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "remove_block", pageSlug: "/", blockId: "b_cta_home" }]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const found = page.blocks.find((b: { id: string }) => b.id === "b_cta_home")
  assert.equal(found, undefined, "removed block should not exist")
})

test("move_block: block moved to top (no afterBlockId)", async () => {
  const session = newSession()
  // Move the CTA (last block) to the top
  const res = await postOps({
    session,
    ops: [{ op: "move_block", pageSlug: "/", blockId: "b_cta_home" }]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  assert.equal(page.blocks[0].id, "b_cta_home", "block should be first after move to top")
})

test("move_block: block moved after a specific block", async () => {
  const session = newSession()
  // Home page order: hero, features, cta — move cta after hero (position 1)
  const res = await postOps({
    session,
    ops: [{ op: "move_block", pageSlug: "/", blockId: "b_cta_home", afterBlockId: "b_hero_home" }]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const ids = page.blocks.map((b: { id: string }) => b.id)
  assert.equal(ids[0], "b_hero_home")
  assert.equal(ids[1], "b_cta_home")
  assert.equal(ids[2], "b_features_home")
})

test("duplicate_block: copy inserted after source block with new id", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "duplicate_block", pageSlug: "/", blockId: "b_hero_home" }]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const heroIdx = page.blocks.findIndex((b: { id: string }) => b.id === "b_hero_home")
  const next = page.blocks[heroIdx + 1]
  assert.ok(next, "a block should follow the original")
  assert.notEqual(next.id, "b_hero_home", "duplicate must have a different id")
  assert.equal(next.type, "Hero", "duplicate should have the same block type")
  assert.equal(next.props.heading, page.blocks[heroIdx].props.heading, "props should be cloned")
})

// ---------------------------------------------------------------------------
// Happy-path: list item ops (FAQAccordion on /pricing)
// ---------------------------------------------------------------------------

test("add_item: item appended to FAQAccordion items list", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        item: { q: "Is there a free trial?", a: "Yes, 14 days free." }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/pricing")
  const page = JSON.parse(pageRes.body)
  const faq = page.blocks.find((b: { id: string }) => b.id === "b_faq_pricing")
  assert.equal(faq.props.items.length, 3, "should have 3 items after add")
  assert.equal(faq.props.items[2].q, "Is there a free trial?")
})

test("add_item: item inserted at specific position via afterIndex", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        item: { q: "Middle question?", a: "Middle answer." },
        afterIndex: 0
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/pricing")
  const page = JSON.parse(pageRes.body)
  const faq = page.blocks.find((b: { id: string }) => b.id === "b_faq_pricing")
  // afterIndex: 0 means insert after position 0, so new item is at index 1
  assert.equal(faq.props.items[1].q, "Middle question?")
})

test("update_item: item patched at correct index", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "update_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        index: 0,
        patch: { q: "Updated question?" }
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/pricing")
  const page = JSON.parse(pageRes.body)
  const faq = page.blocks.find((b: { id: string }) => b.id === "b_faq_pricing")
  assert.equal(faq.props.items[0].q, "Updated question?")
  assert.equal(faq.props.items[0].a, "Yes, there are no long-term contracts.", "other fields should be unchanged")
})

test("remove_item: item removed and list shrinks", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "remove_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        index: 0
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/pricing")
  const page = JSON.parse(pageRes.body)
  const faq = page.blocks.find((b: { id: string }) => b.id === "b_faq_pricing")
  assert.equal(faq.props.items.length, 1, "should have 1 item after removal")
  assert.equal(faq.props.items[0].q, "Do you offer support?", "second item should now be first")
})

test("move_item: item reordered within list", async () => {
  const session = newSession()
  // FAQ starts with [cancel, support]. Move index 1 (support) before index 0 (cancel).
  const res = await postOps({
    session,
    ops: [
      {
        op: "move_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        index: 1
        // no afterIndex means move to top
      }
    ]
  })
  assert.equal(res.statusCode, 200)
  const pageRes = await getPage(session, "/pricing")
  const page = JSON.parse(pageRes.body)
  const faq = page.blocks.find((b: { id: string }) => b.id === "b_faq_pricing")
  assert.equal(faq.props.items[0].q, "Do you offer support?", "moved item should now be first")
  assert.equal(faq.props.items[1].q, "Can I cancel anytime?")
})

// ---------------------------------------------------------------------------
// Error / guard tests
// ---------------------------------------------------------------------------

test("error: block op on unknown pageSlug is rejected with an error", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "remove_block", pageSlug: "/does-not-exist", blockId: "b_hero_home" }]
  })
  // The /ops endpoint pre-validates page existence and returns 404 before
  // calling applyOpsAtomically; the important thing is that it is rejected.
  assert.ok(res.statusCode === 400 || res.statusCode === 404, `expected 400 or 404, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert.ok(body.error, "should return an error message")
})

test("error: update_props on unknown blockId returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "update_props", pageSlug: "/", blockId: "b_nonexistent", patch: { heading: "New" } }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: remove_block on unknown blockId returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "remove_block", pageSlug: "/", blockId: "b_nonexistent" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: move_block on unknown blockId returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "move_block", pageSlug: "/", blockId: "b_nonexistent" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: duplicate_block on unknown blockId returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "duplicate_block", pageSlug: "/", blockId: "b_nonexistent" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: add_block with unknown afterBlockId returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        afterBlockId: "b_nonexistent",
        block: {
          id: "b_cta_test",
          type: "CTA",
          props: { title: "T", description: "D", ctaText: "Go", ctaHref: "/" }
        }
      }
    ]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: remove_page on / (home) returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [{ op: "remove_page", pageSlug: "/" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error, "should reject removal of home page")
})

test("error: removing the last remaining page returns 400", async () => {
  const session = newSession()
  // Remove /pricing first (leaving only /)
  await postOps({ session, ops: [{ op: "remove_page", pageSlug: "/pricing" }] })
  // Now try to remove the only remaining page
  const res = await postOps({
    session,
    ops: [{ op: "remove_page", pageSlug: "/" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: add_block with invalid props (Hero missing required heading) returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_block",
        pageSlug: "/",
        block: {
          id: "b_bad_hero",
          type: "Hero",
          props: {
            // heading deliberately omitted
            subheading: "Sub",
            ctaText: "Go",
            ctaHref: "/",
            imageUrl: "/img.svg",
            imageAlt: "alt"
          }
        }
      }
    ]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: update_props producing invalid props (empty heading) returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "update_props",
        pageSlug: "/",
        blockId: "b_hero_home",
        patch: { heading: "" }
      }
    ]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error, "empty heading should fail schema validation")
})

test("error: add_item with out-of-range afterIndex returns 400", async () => {
  const session = newSession()
  // FAQ has 2 items (indices 0..1). afterIndex 99 is out of range.
  const res = await postOps({
    session,
    ops: [
      {
        op: "add_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        item: { q: "Q", a: "A" },
        afterIndex: 99
      }
    ]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: update_item with out-of-range index returns 400", async () => {
  const session = newSession()
  const res = await postOps({
    session,
    ops: [
      {
        op: "update_item",
        pageSlug: "/pricing",
        blockId: "b_faq_pricing",
        listKey: "items",
        index: 50,
        patch: { q: "Nope" }
      }
    ]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

test("error: rename_page to a slug that already exists returns 400", async () => {
  const session = newSession()
  // Try to rename /pricing to / (which already exists)
  const res = await postOps({
    session,
    ops: [{ op: "rename_page", pageSlug: "/pricing", newPageSlug: "/" }]
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body)
  assert.ok(body.error)
})

// ---------------------------------------------------------------------------
// Atomicity test
// ---------------------------------------------------------------------------

test("atomicity: batch with a valid op followed by an invalid op is fully rolled back", async () => {
  const session = newSession()

  // Op 1 is valid: update Hero heading
  // Op 2 is invalid: update_props on a nonexistent block
  const res = await postOps({
    session,
    ops: [
      { op: "update_props", pageSlug: "/", blockId: "b_hero_home", patch: { heading: "Should not persist" } },
      { op: "update_props", pageSlug: "/", blockId: "b_block_that_does_not_exist", patch: { heading: "Bad" } }
    ]
  })
  assert.equal(res.statusCode, 400, "batch should be rejected")

  // Verify that the first op's effect was NOT persisted
  const pageRes = await getPage(session, "/")
  const page = JSON.parse(pageRes.body)
  const hero = page.blocks.find((b: { id: string }) => b.id === "b_hero_home")
  assert.notEqual(
    hero.props.heading,
    "Should not persist",
    "first op must be rolled back because the batch failed"
  )
  assert.equal(
    hero.props.heading,
    "Build websites with plain language",
    "heading should still be the original demo value"
  )
})
