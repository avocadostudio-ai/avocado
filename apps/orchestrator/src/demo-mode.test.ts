import test from "node:test"
import assert from "node:assert/strict"
import type { Operation, PageDoc } from "@ai-site-editor/shared"
import {
  splitDemoOps,
  enforceDemoOps,
  demoSessionKeyForIp,
  consumeDemoRateToken,
  _resetDemoRateLimiterForTests,
  isDemoModeEnabled
} from "./demo-mode.js"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function pageWithHeroAndCta(): PageDoc {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "b_hero",
        type: "Hero",
        props: {
          heading: "Hello",
          subheading: "World"
        }
      },
      {
        id: "b_cta",
        type: "CTA",
        props: {
          title: "Do it",
          description: "Now",
          ctaText: "Go",
          ctaHref: "/"
        }
      }
    ]
  }
}

function stagedFromPage(page: PageDoc): Map<string, PageDoc> {
  return new Map([[page.slug, page]])
}

// ---------------------------------------------------------------------------
// splitDemoOps — the core allow/deny logic
// ---------------------------------------------------------------------------

test("splitDemoOps: allows update_props on Hero block", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "New heading" } }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 1)
  assert.equal(result.rejected.length, 0)
})

test("splitDemoOps: rejects update_props on non-Hero block (CTA)", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "Changed" } }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]!.reason, /CTA/)
})

test("splitDemoOps: rejects add_block even on Hero target", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_hero_2",
        type: "Hero",
        props: { heading: "x", subheading: "y" }
      }
    }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]!.reason, /add_block/)
})

test("splitDemoOps: rejects remove_block, move_block, create_page, etc.", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "remove_block", pageSlug: "/", blockId: "b_hero" },
    { op: "move_block", pageSlug: "/", blockId: "b_hero", afterBlockId: "b_cta" },
    {
      op: "create_page",
      page: {
        id: "p_x",
        slug: "/x",
        title: "X",
        updatedAt: new Date().toISOString(),
        blocks: []
      }
    }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 0)
  assert.equal(result.rejected.length, 3)
})

test("splitDemoOps: rejects update_props on unknown blockId", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_does_not_exist", patch: { heading: "x" } }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]!.reason, /not found/)
})

test("splitDemoOps: allows multiple update_props on Hero in one plan", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "A" } },
    { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { subheading: "B" } }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 2)
  assert.equal(result.rejected.length, 0)
})

test("splitDemoOps: mixed plan — keeps allowed, rejects forbidden", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "OK" } },
    { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "NOPE" } }
  ]
  const result = splitDemoOps(ops, staged)
  assert.equal(result.allowed.length, 1)
  assert.equal(result.rejected.length, 1)
})

// ---------------------------------------------------------------------------
// enforceDemoOps — throws on any rejection
// ---------------------------------------------------------------------------

test("enforceDemoOps: no-op on all-allowed plan", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "x" } }
  ]
  assert.doesNotThrow(() => enforceDemoOps(ops, staged))
})

test("enforceDemoOps: throws with friendly userMessage on violation", () => {
  const staged = stagedFromPage(pageWithHeroAndCta())
  const ops: Operation[] = [
    { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "x" } }
  ]
  assert.throws(
    () => enforceDemoOps(ops, staged),
    (err: Error & { userMessage?: string }) => {
      assert.ok(err.message.includes("Demo mode"))
      assert.ok(err.userMessage?.toLowerCase().includes("hero"))
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// demoSessionKeyForIp — deterministic per-IP isolation
// ---------------------------------------------------------------------------

test("demoSessionKeyForIp: same IP yields same key", () => {
  const k1 = demoSessionKeyForIp("1.2.3.4")
  const k2 = demoSessionKeyForIp("1.2.3.4")
  assert.equal(k1, k2)
})

test("demoSessionKeyForIp: different IPs yield different keys", () => {
  const k1 = demoSessionKeyForIp("1.2.3.4")
  const k2 = demoSessionKeyForIp("5.6.7.8")
  assert.notEqual(k1, k2)
})

test("demoSessionKeyForIp: key has no '::' so it routes through legacy session seed path", () => {
  const key = demoSessionKeyForIp("1.2.3.4")
  assert.ok(!key.includes("::"), `expected no '::' in ${key}`)
  assert.ok(key.startsWith("demo-"))
})

test("demoSessionKeyForIp: empty/missing IP falls back to anon", () => {
  const k1 = demoSessionKeyForIp("")
  const k2 = demoSessionKeyForIp("anon")
  assert.equal(k1, k2)
})

// ---------------------------------------------------------------------------
// consumeDemoRateToken — in-memory sliding-window limiter
// ---------------------------------------------------------------------------

test("consumeDemoRateToken: allows requests under the per-hour limit", () => {
  _resetDemoRateLimiterForTests()
  const ip = "10.0.0.1"
  for (let i = 0; i < 5; i += 1) {
    const result = consumeDemoRateToken(ip)
    assert.equal(result.ok, true, `request ${i + 1} should succeed`)
  }
})

test("consumeDemoRateToken: blocks requests exceeding the limit (default 20/hour)", () => {
  _resetDemoRateLimiterForTests()
  const ip = "10.0.0.2"
  for (let i = 0; i < 20; i += 1) {
    const result = consumeDemoRateToken(ip)
    assert.equal(result.ok, true)
  }
  const blocked = consumeDemoRateToken(ip)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.ok(blocked.retryAfterSeconds > 0)
  }
})

test("consumeDemoRateToken: separate IPs get separate buckets", () => {
  _resetDemoRateLimiterForTests()
  for (let i = 0; i < 20; i += 1) consumeDemoRateToken("10.0.0.3")
  const alice = consumeDemoRateToken("10.0.0.3")
  const bob = consumeDemoRateToken("10.0.0.4")
  assert.equal(alice.ok, false)
  assert.equal(bob.ok, true)
})

// ---------------------------------------------------------------------------
// isDemoModeEnabled — reads DEMO_MODE env var
// ---------------------------------------------------------------------------

test("isDemoModeEnabled: returns false when DEMO_MODE is unset", () => {
  const prior = process.env.DEMO_MODE
  delete process.env.DEMO_MODE
  try {
    assert.equal(isDemoModeEnabled(), false)
  } finally {
    if (prior !== undefined) process.env.DEMO_MODE = prior
  }
})

test("isDemoModeEnabled: returns true when DEMO_MODE=1", () => {
  const prior = process.env.DEMO_MODE
  process.env.DEMO_MODE = "1"
  try {
    assert.equal(isDemoModeEnabled(), true)
  } finally {
    if (prior === undefined) delete process.env.DEMO_MODE
    else process.env.DEMO_MODE = prior
  }
})
