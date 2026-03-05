import assert from "node:assert/strict"
import test from "node:test"
import type { PageDoc } from "@ai-site-editor/shared"
import { resolvePageAndNav } from "../lib/content-resolver.ts"

const samplePage: PageDoc = {
  id: "p_home",
  slug: "/",
  title: "Home",
  updatedAt: "2026-03-05T00:00:00.000Z",
  blocks: []
}

test("resolvePageAndNav uses published content only when source=published", async () => {
  let publishedPageCalls = 0
  let publishedSlugsCalls = 0
  let draftPageCalls = 0
  let draftSlugsCalls = 0

  const result = await resolvePageAndNav(
    { source: "published", slug: "/", session: "dev", siteId: "demo" },
    {
      getPublishedPage: () => {
        publishedPageCalls += 1
        return samplePage
      },
      getPublishedSlugs: () => {
        publishedSlugsCalls += 1
        return ["/", "/pricing"]
      },
      fetchDraftPage: async () => {
        draftPageCalls += 1
        return null
      },
      fetchDraftSlugs: async () => {
        draftSlugsCalls += 1
        return []
      }
    }
  )

  assert.equal(publishedPageCalls, 1)
  assert.equal(publishedSlugsCalls, 1)
  assert.equal(draftPageCalls, 0)
  assert.equal(draftSlugsCalls, 0)
  assert.equal(result.page?.slug, "/")
  assert.deepEqual(result.slugs, ["/", "/pricing"])
})

test("resolvePageAndNav uses draft content only when source=draft", async () => {
  let publishedPageCalls = 0
  let publishedSlugsCalls = 0
  let draftPageCalls = 0
  let draftSlugsCalls = 0
  const strictFlags: boolean[] = []

  const result = await resolvePageAndNav(
    { source: "draft", slug: "/", session: "dev", siteId: "demo" },
    {
      getPublishedPage: () => {
        publishedPageCalls += 1
        return samplePage
      },
      getPublishedSlugs: () => {
        publishedSlugsCalls += 1
        return ["/"]
      },
      fetchDraftPage: async (_slug, _session, _siteId, strictDraft) => {
        draftPageCalls += 1
        strictFlags.push(Boolean(strictDraft))
        return samplePage
      },
      fetchDraftSlugs: async (_session, _siteId, strictDraft) => {
        draftSlugsCalls += 1
        strictFlags.push(Boolean(strictDraft))
        return ["/", "/draft-only"]
      }
    }
  )

  assert.equal(publishedPageCalls, 0)
  assert.equal(publishedSlugsCalls, 0)
  assert.equal(draftPageCalls, 1)
  assert.equal(draftSlugsCalls, 1)
  assert.deepEqual(strictFlags, [true, true])
  assert.equal(result.page?.slug, "/")
  assert.deepEqual(result.slugs, ["/", "/draft-only"])
})
