/**
 * Session introspection route tests.
 *
 * Covers GET /whoami and GET /sessions using Fastify .inject().
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { app } from "../index.js"
import { bumpVersion, pushVersionEntry } from "../state/session-state.js"
import { createSessionFactory, seedSession, makeHomePage } from "../test/fixtures.js"

const newSession = createSessionFactory("sessions-route-test")

describe("GET /whoami", () => {
  it("returns a summary of the caller's bound session", async () => {
    const siteId = `site-${Date.now()}`
    const scopedKey = `${siteId}::${newSession()}`
    const [, session] = scopedKey.split("::")
    seedSession(scopedKey, makeHomePage({ slug: "/" }), makeHomePage({ slug: "/about" }))
    const version = bumpVersion(scopedKey)
    pushVersionEntry(scopedKey, {
      version,
      slug: "/",
      summary: "seed",
      opTypes: ["create_page"],
      opCount: 1,
      source: "direct",
      snapshot: null,
    })

    const res = await app.inject({
      method: "GET",
      url: `/whoami?session=${session}&siteId=${siteId}`,
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      sessionKey: string
      session: string
      siteId: string
      version: number
      draftPageCount: number
      lastMutatedAt: string | null
      publishedPageCount: number
      orchestratorUrl: string
    }
    assert.equal(body.sessionKey, scopedKey)
    assert.equal(body.session, session)
    assert.equal(body.siteId, siteId)
    assert.equal(body.draftPageCount, 2)
    assert.ok(body.version >= 1)
    assert.ok(body.lastMutatedAt !== null, "lastMutatedAt should be set after a version log entry")
    assert.equal(typeof body.publishedPageCount, "number")
    assert.ok(typeof body.orchestratorUrl === "string" && body.orchestratorUrl.length > 0)
  })

  it("returns a zeroed summary for an unknown session (no error)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/whoami?session=nobody&siteId=unknown-site-${Date.now()}`,
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { draftPageCount: number; version: number; lastMutatedAt: string | null }
    assert.equal(body.draftPageCount, 0)
    assert.equal(body.version, 0)
    assert.equal(body.lastMutatedAt, null)
  })
})

describe("GET /sessions", () => {
  it("includes a seeded scoped session in the directory", async () => {
    const siteId = `site-list-${Date.now()}`
    const scopedKey = `${siteId}::${newSession()}`
    seedSession(scopedKey, makeHomePage({ slug: "/" }))
    bumpVersion(scopedKey)

    const res = await app.inject({ method: "GET", url: "/sessions" })
    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      sessions: Array<{ sessionKey: string; siteId: string; draftPageCount: number }>
      publishedPageCount: number
    }
    assert.ok(Array.isArray(body.sessions))
    const found = body.sessions.find((s) => s.sessionKey === scopedKey)
    assert.ok(found, `expected /sessions to include ${scopedKey}`)
    assert.equal(found!.siteId, siteId)
    assert.equal(found!.draftPageCount, 1)
    assert.equal(typeof body.publishedPageCount, "number")
  })
})
