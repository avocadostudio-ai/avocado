import test from "node:test"
import assert from "node:assert/strict"
import {
  createSessionFactory,
  postOps,
  getSlugs,
  seedSession,
  getDraft,
  makeHomePage,
  makePricingPage,
  resetSessionState
} from "./test/fixtures.js"
import {
  pushUndo,
  getHistoryMap,
  historyUndo,
  historyRedo,
  getPage as getPageState,
  setPage,
  removePage,
  bumpVersion
} from "./state/session-state.js"
import { app } from "./index.js"

const newSession = createSessionFactory("undo-page-ops")

// ---------------------------------------------------------------------------
// pushUndo accepts null (create_page sentinel)
// ---------------------------------------------------------------------------

test("pushUndo(null) stores null sentinel — undo removes the page", () => {
  const session = newSession()
  seedSession(session, makeHomePage())

  // Simulate creating /about — push null as the undo snapshot
  pushUndo(session, "/about", null)

  const undoMap = getHistoryMap(historyUndo, session)
  const list = undoMap.get("/about")
  assert.ok(list, "undo list should exist for /about")
  assert.equal(list.length, 1)
  assert.equal(list[0], null, "undo entry should be null sentinel")
})

// ---------------------------------------------------------------------------
// Undo after create_page via /ops deletes the created page
// ---------------------------------------------------------------------------

test("undo after create_page via /ops removes the created page", async () => {
  const session = newSession()
  // Seed home page
  seedSession(session, makeHomePage())

  // Create a new page via /ops
  const createRes = await postOps({
    session,
    ops: [{
      op: "create_page",
      page: {
        id: "p_about",
        slug: "/about",
        title: "About",
        updatedAt: new Date().toISOString(),
        blocks: [{ id: "b_hero_about", type: "Hero", props: { heading: "About", subheading: "Us", ctaText: "Go", ctaHref: "/", imageUrl: "/hero.svg", imageAlt: "hero" } }]
      }
    }]
  })
  assert.equal(createRes.statusCode, 200)

  // Verify page exists
  let slugs = await getSlugs(session)
  assert.ok(slugs.slugs.includes("/about"))

  // Undo
  const undoRes = await app.inject({
    method: "POST",
    url: "/history/undo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, slug: "/about" })
  })
  assert.equal(undoRes.statusCode, 200)
  const undoBody = JSON.parse(undoRes.body) as { status: string; navigateToSlug?: string }
  assert.equal(undoBody.status, "applied")
  assert.equal(undoBody.navigateToSlug, "/", "should navigate to home after undoing create_page")

  // Page should be gone
  slugs = await getSlugs(session)
  assert.ok(!slugs.slugs.includes("/about"), "page should be removed after undo")
})

// ---------------------------------------------------------------------------
// Undo after remove_page (direct state) restores the page
// ---------------------------------------------------------------------------

test("undo after remove_page restores the deleted page", async () => {
  const session = newSession()
  seedSession(session, makeHomePage(), makePricingPage())

  // Capture snapshot before removal
  const pricingBefore = getPageState(session, "/pricing")
  assert.ok(pricingBefore)

  // Push the page snapshot as undo, then remove
  pushUndo(session, "/pricing", pricingBefore)
  removePage(session, "/pricing")
  bumpVersion(session)

  // Verify page is gone
  assert.equal(getPageState(session, "/pricing"), null)

  // Undo — should restore
  const undoRes = await app.inject({
    method: "POST",
    url: "/history/undo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, slug: "/pricing" })
  })
  assert.equal(undoRes.statusCode, 200)
  const undoBody = JSON.parse(undoRes.body) as { status: string; navigateToSlug?: string }
  assert.equal(undoBody.status, "applied")
  assert.equal(undoBody.navigateToSlug, "/pricing", "should navigate to restored page")

  // Page should be back
  const restored = getPageState(session, "/pricing")
  assert.ok(restored, "page should be restored after undo")
  assert.equal(restored.title, "Pricing")
})

// ---------------------------------------------------------------------------
// Redo after undoing create_page re-creates the page
// ---------------------------------------------------------------------------

test("redo after undoing create_page re-creates the page", async () => {
  const session = newSession()
  seedSession(session, makeHomePage())

  // Create page, then undo
  await postOps({
    session,
    ops: [{
      op: "create_page",
      page: {
        id: "p_about2",
        slug: "/about",
        title: "About",
        updatedAt: new Date().toISOString(),
        blocks: []
      }
    }]
  })

  await app.inject({
    method: "POST",
    url: "/history/undo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, slug: "/about" })
  })

  // Page should be gone
  assert.equal(getPageState(session, "/about"), null)

  // Redo — should re-create
  const redoRes = await app.inject({
    method: "POST",
    url: "/history/redo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, slug: "/about" })
  })
  assert.equal(redoRes.statusCode, 200)
  const redoBody = JSON.parse(redoRes.body) as { status: string; navigateToSlug?: string }
  assert.equal(redoBody.status, "applied")
  assert.equal(redoBody.navigateToSlug, "/about", "should navigate to re-created page")

  // Page should be back
  const restored = getPageState(session, "/about")
  assert.ok(restored, "page should be re-created after redo")
})

// ---------------------------------------------------------------------------
// Regular edit undo still works (regression check)
// ---------------------------------------------------------------------------

test("undo after update_props reverts the change (regression)", async () => {
  const session = newSession()
  seedSession(session, makeHomePage())

  const res = await postOps({
    session,
    ops: [{
      op: "update_props",
      pageSlug: "/",
      blockId: "b_hero",
      patch: { props: { heading: "Updated Heading" } }
    }]
  })
  assert.equal(res.statusCode, 200)

  // Verify the update
  let page = getPageState(session, "/")
  assert.ok(page)
  const hero = page.blocks.find((b) => b.id === "b_hero")
  assert.equal((hero?.props as Record<string, unknown>).heading, "Updated Heading")

  // Undo
  const undoRes = await app.inject({
    method: "POST",
    url: "/history/undo",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, slug: "/" })
  })
  assert.equal(undoRes.statusCode, 200)
  const undoBody = JSON.parse(undoRes.body) as { status: string; navigateToSlug?: string }
  assert.equal(undoBody.status, "applied")
  assert.equal(undoBody.navigateToSlug, undefined, "no navigation needed for same-page undo")

  // Should be reverted
  page = getPageState(session, "/")
  assert.ok(page)
  const heroReverted = page.blocks.find((b) => b.id === "b_hero")
  assert.equal((heroReverted?.props as Record<string, unknown>).heading, "Hello")
})
