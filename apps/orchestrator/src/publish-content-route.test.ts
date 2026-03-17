import test from "node:test"
import assert from "node:assert/strict"
import { app } from "./index.js"

function createSessionId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

test("publish/content: rejects requests without siteId", async () => {
  const session = createSessionId("publish-content")
  const res = await app.inject({
    method: "GET",
    url: `/publish/content?session=${encodeURIComponent(session)}`
  })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body) as { error?: string }
  assert.equal(body.error, "siteId is required")
})

test("publish/content: returns content for explicit siteId scope", async () => {
  const session = createSessionId("publish-content")
  const siteId = "tenant-alpha"
  const createRes = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session,
      siteId,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_landing",
            slug: "/landing",
            title: "Landing",
            updatedAt: new Date().toISOString(),
            blocks: []
          }
        }
      ]
    })
  })
  assert.equal(createRes.statusCode, 200)

  const res = await app.inject({
    method: "GET",
    url: `/publish/content?session=${encodeURIComponent(session)}&siteId=${encodeURIComponent(siteId)}`
  })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body) as {
    session: string
    slugs: string[]
    pages: Array<{ slug: string }>
  }
  assert.equal(body.session, session)
  assert.deepEqual(body.slugs, ["/landing"])
  assert.equal(body.pages[0]?.slug, "/landing")
})
