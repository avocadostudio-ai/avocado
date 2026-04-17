import test from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"
import { setPage, scopedSessionKey, draftPages } from "./state/session-state.js"
import type { PageDoc } from "@ai-site-editor/shared"

function createSessionId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

function makePage(slug: string, title: string): PageDoc {
  return {
    id: `p_${slug.replace(/[^a-z0-9]/gi, "_") || "home"}`,
    slug,
    title,
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: `b_hero_${slug.replace(/[^a-z0-9]/gi, "_") || "home"}`,
        type: "Hero",
        props: {
          headline: `${title} headline`,
          subheadline: "sub",
          ctaLabel: "Go",
          ctaHref: "/",
          imageUrl: "https://example.com/img.png",
          imageAlt: "alt"
        }
      }
    ]
  }
}

test("/draft/bootstrap overwrite preserves draft-only pages", async () => {
  const session = createSessionId("bootstrap-preserve")
  const siteId = "avocado-hub"
  const scoped = scopedSessionKey(session, siteId)

  // Seed draft with a home page and a draft-only "duplicate" page (like /olives2
  // produced by `duplicate_page`). The duplicate has NO counterpart in the CMS.
  setPage(scoped, makePage("/", "Home draft"))
  setPage(scoped, makePage("/olives2", "Olives Two (draft-only)"))

  // Simulate the editor re-syncing from the CMS on refresh. The CMS only knows
  // about "/" — the draft-only /olives2 is not in the payload.
  const cmsHome = makePage("/", "Home from CMS")
  const res = await app.inject({
    method: "POST",
    url: "/draft/bootstrap",
    payload: {
      session,
      siteId,
      pages: [cmsHome],
      overwrite: true
    }
  })

  assert.equal(res.statusCode, 200)
  const body = res.json() as { status: string; slugs: string[] }
  assert.equal(body.status, "bootstrapped")

  // /olives2 must still be present — this is the regression guard.
  assert.ok(body.slugs.includes("/olives2"), `expected /olives2 preserved, got ${JSON.stringify(body.slugs)}`)
  assert.ok(body.slugs.includes("/"), `expected / present, got ${JSON.stringify(body.slugs)}`)

  // The home page should have been replaced by the CMS version.
  const draft = draftPages.get(scoped)
  assert.ok(draft)
  assert.equal(draft!.get("/")?.title, "Home from CMS")
  // The draft-only page's content must remain intact.
  assert.equal(draft!.get("/olives2")?.title, "Olives Two (draft-only)")
})

test("/draft/bootstrap overwrite still replaces pages that exist in source", async () => {
  const session = createSessionId("bootstrap-replace")
  const siteId = "avocado-hub"
  const scoped = scopedSessionKey(session, siteId)

  setPage(scoped, makePage("/", "Stale draft home"))

  const cmsHome = makePage("/", "Fresh CMS home")
  const res = await app.inject({
    method: "POST",
    url: "/draft/bootstrap",
    payload: {
      session,
      siteId,
      pages: [cmsHome],
      overwrite: true
    }
  })

  assert.equal(res.statusCode, 200)
  const draft = draftPages.get(scoped)
  assert.ok(draft)
  assert.equal(draft!.get("/")?.title, "Fresh CMS home")
})
