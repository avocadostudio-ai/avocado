import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeSiteId,
  normalizeSession,
  scopedSessionKey,
  DEFAULT_SITE_ID,
  DEFAULT_SESSION,
  ensureHeroImageProps,
  orderSlugsHomeFirst,
  nestedPageMapToObject,
  objectToNestedPageMap,
  nestedHistoryMapToObject,
  objectToNestedHistoryMap,
  applyPersistedState,
  publishedPages,
  draftPages,
  historyUndo,
  historyRedo,
  versions,
  recentEdits,
  chatHistoryBySession,
  siteConfigs,
  CHAT_HISTORY_MAX_TURNS,
  pushChatHistory,
  pushRecentEdit,
  getRecentEdits,
  issueTouchedSlugsByKey,
  setIssueTouchedSlugs,
  getIssueTouchedSlugs,
  evictStaleEphemeralMaps,
  pendingApprovalPlanBySession,
  publishStatusBySession,
  continuationChainBySession,
} from "./session-state.js"
import type { PageDoc } from "@ai-site-editor/shared"
import type { PersistedState, PendingApprovalPlan, PublishTracker } from "./session-state.js"

// ---------------------------------------------------------------------------
// normalizeSiteId
// ---------------------------------------------------------------------------

test("normalizeSiteId: returns default for non-string input", () => {
  assert.equal(normalizeSiteId(undefined), DEFAULT_SITE_ID)
  assert.equal(normalizeSiteId(null), DEFAULT_SITE_ID)
  assert.equal(normalizeSiteId(42), DEFAULT_SITE_ID)
})

test("normalizeSiteId: lowercases and replaces invalid chars", () => {
  assert.equal(normalizeSiteId("My Site!"), "my-site")
  assert.equal(normalizeSiteId("HELLO WORLD"), "hello-world")
  assert.equal(normalizeSiteId("test@#$site"), "test-site")
})

test("normalizeSiteId: trims leading/trailing hyphens", () => {
  assert.equal(normalizeSiteId("--test--"), "test")
})

test("normalizeSiteId: returns default for empty string", () => {
  assert.equal(normalizeSiteId(""), DEFAULT_SITE_ID)
  assert.equal(normalizeSiteId("   "), DEFAULT_SITE_ID)
})

test("normalizeSiteId: preserves valid slugs", () => {
  assert.equal(normalizeSiteId("my-site-123"), "my-site-123")
  assert.equal(normalizeSiteId("test_site"), "test_site")
})

// ---------------------------------------------------------------------------
// normalizeSession
// ---------------------------------------------------------------------------

test("normalizeSession: returns default for non-string input", () => {
  assert.equal(normalizeSession(undefined), DEFAULT_SESSION)
  assert.equal(normalizeSession(null), DEFAULT_SESSION)
  assert.equal(normalizeSession(42), DEFAULT_SESSION)
})

test("normalizeSession: trims whitespace", () => {
  assert.equal(normalizeSession("  dev  "), "dev")
})

test("normalizeSession: returns default for empty string", () => {
  assert.equal(normalizeSession(""), DEFAULT_SESSION)
  assert.equal(normalizeSession("  "), DEFAULT_SESSION)
})

// ---------------------------------------------------------------------------
// scopedSessionKey
// ---------------------------------------------------------------------------

test("scopedSessionKey: legacy/avocado returns session directly", () => {
  assert.equal(scopedSessionKey("dev", "avocado-stories"), "dev")
  assert.equal(scopedSessionKey("prod", "default"), "prod")
})

test("scopedSessionKey: non-default site returns siteId::session", () => {
  assert.equal(scopedSessionKey("dev", "my-site"), "my-site::dev")
  assert.equal(scopedSessionKey("prod", "villa-web"), "villa-web::prod")
})

test("scopedSessionKey: normalizes inputs", () => {
  assert.equal(scopedSessionKey(undefined, undefined), DEFAULT_SESSION)
  assert.equal(scopedSessionKey("dev", "My Site!"), "my-site::dev")
})

// ---------------------------------------------------------------------------
// ensureHeroImageProps
// ---------------------------------------------------------------------------

test("ensureHeroImageProps: sets default imageUrl/imageAlt on Hero blocks", () => {
  const page: PageDoc = {
    id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01",
    blocks: [{ id: "b1", type: "Hero", props: { heading: "Hi" } }]
  }
  ensureHeroImageProps(page)
  const props = page.blocks[0].props as Record<string, unknown>
  assert.equal(props.imageUrl, "/hero-generated.svg")
  assert.ok(typeof props.imageAlt === "string" && props.imageAlt.length > 0)
})

test("ensureHeroImageProps: preserves existing imageUrl/imageAlt", () => {
  const page: PageDoc = {
    id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01",
    blocks: [{ id: "b1", type: "Hero", props: { heading: "Hi", imageUrl: "/custom.png", imageAlt: "Custom" } }]
  }
  ensureHeroImageProps(page)
  const props = page.blocks[0].props as Record<string, unknown>
  assert.equal(props.imageUrl, "/custom.png")
  assert.equal(props.imageAlt, "Custom")
})

test("ensureHeroImageProps: sets pricing-specific alt text", () => {
  const page: PageDoc = {
    id: "p1", slug: "/pricing", title: "Pricing", updatedAt: "2026-01-01",
    blocks: [{ id: "b1", type: "Hero", props: { heading: "Plans" } }]
  }
  ensureHeroImageProps(page)
  const props = page.blocks[0].props as Record<string, unknown>
  assert.ok((props.imageAlt as string).includes("pricing"))
})

test("ensureHeroImageProps: initializes TwoColumn left/right from legacy props", () => {
  const page: PageDoc = {
    id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01",
    blocks: [{
      id: "b1", type: "TwoColumn",
      props: { heading: "Title", body: "Content", imageUrl: "/img.png", imageAlt: "Img" }
    }]
  }
  ensureHeroImageProps(page)
  const props = page.blocks[0].props as Record<string, unknown>
  assert.ok(Array.isArray(props.left))
  assert.ok(Array.isArray(props.right))
  assert.equal(props.variant, "default")
})

// ---------------------------------------------------------------------------
// orderSlugsHomeFirst
// ---------------------------------------------------------------------------

test("orderSlugsHomeFirst: moves / to front", () => {
  assert.deepEqual(orderSlugsHomeFirst(["/pricing", "/", "/about"]), ["/", "/pricing", "/about"])
})

test("orderSlugsHomeFirst: preserves order when no /", () => {
  assert.deepEqual(orderSlugsHomeFirst(["/pricing", "/about"]), ["/pricing", "/about"])
})

// ---------------------------------------------------------------------------
// Map ↔ Object round-trip (persistence helpers)
// ---------------------------------------------------------------------------

test("nestedPageMap round-trip: object → map → object", () => {
  const original: Record<string, Record<string, PageDoc>> = {
    dev: {
      "/": { id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01", blocks: [] },
      "/about": { id: "p2", slug: "/about", title: "About", updatedAt: "2026-01-01", blocks: [] }
    }
  }
  const asMap = objectToNestedPageMap(original)
  assert.equal(asMap.size, 1)
  assert.equal(asMap.get("dev")!.size, 2)

  const backToObj = nestedPageMapToObject(asMap)
  assert.deepEqual(backToObj.dev["/"].title, "Home")
  assert.deepEqual(backToObj.dev["/about"].title, "About")
})

test("objectToNestedPageMap: handles null/undefined gracefully", () => {
  assert.equal(objectToNestedPageMap(null).size, 0)
  assert.equal(objectToNestedPageMap(undefined).size, 0)
  assert.equal(objectToNestedPageMap("string").size, 0)
})

test("nestedHistoryMap round-trip: object → map → object", () => {
  const page: PageDoc = { id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01", blocks: [] }
  const original: Record<string, Record<string, (PageDoc | null)[]>> = {
    dev: { "/": [page, null, page] }
  }
  const asMap = objectToNestedHistoryMap(original)
  assert.equal(asMap.get("dev")!.get("/")!.length, 3)
  assert.equal(asMap.get("dev")!.get("/")![1], null)

  const backToObj = nestedHistoryMapToObject(asMap)
  assert.equal(backToObj.dev["/"].length, 3)
  assert.equal(backToObj.dev["/"][1], null)
})

test("objectToNestedHistoryMap: filters invalid entries", () => {
  const result = objectToNestedHistoryMap({ dev: { "/": [null, "bad", 42, { id: "p1" }] } })
  const list = result.get("dev")!.get("/")!
  // null and objects pass, "bad" and 42 are filtered
  assert.equal(list.length, 2)
  assert.equal(list[0], null)
})

// ---------------------------------------------------------------------------
// applyPersistedState — round-trip
// ---------------------------------------------------------------------------

test("applyPersistedState: restores all state maps from persisted payload", () => {
  const page1: PageDoc = {
    id: "p1", slug: "/", title: "Home", updatedAt: "2026-01-01",
    blocks: [{ id: "b1", type: "Hero", props: { heading: "Hi", imageUrl: "/hero.svg", imageAlt: "Hero" } }]
  }
  const page2: PageDoc = {
    id: "p2", slug: "/about", title: "About", updatedAt: "2026-01-01",
    blocks: []
  }

  const payload: PersistedState = {
    publishedPages: [page1],
    draftPages: { "test-persist": { "/": page1, "/about": page2 } },
    historyUndo: { "test-persist": { "/": [page1] } },
    historyRedo: { "test-persist": { "/": [] } },
    versions: { "test-persist": 5 },
    recentEdits: { "test-persist": [{ slug: "/", summary: "Updated", ops: [], at: "2026-01-01" }] },
    chatHistory: { "test-persist": [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] },
    siteConfigs: { "test-persist": { name: "Test Site" } }
  }

  applyPersistedState(payload)

  // Verify published pages
  assert.ok(publishedPages.has("/"))
  assert.equal(publishedPages.get("/")!.title, "Home")

  // Verify draft pages
  assert.ok(draftPages.has("test-persist"))
  assert.equal(draftPages.get("test-persist")!.size, 2)

  // Verify undo/redo
  assert.ok(historyUndo.has("test-persist"))
  assert.equal(historyUndo.get("test-persist")!.get("/")!.length, 1)

  // Verify versions
  assert.equal(versions.get("test-persist"), 5)

  // Verify recent edits
  assert.equal(recentEdits.get("test-persist")!.length, 1)

  // Verify chat history
  assert.equal(chatHistoryBySession.get("test-persist")!.length, 2)

  // Verify site configs (avocado-hub default always present)
  assert.ok(siteConfigs.has("avocado-hub::dev"))
  assert.equal(siteConfigs.get("test-persist")!.name, "Test Site")
})

test("applyPersistedState: handles empty/missing fields gracefully", () => {
  applyPersistedState({})
  // Should not throw; default avocado-hub config should be re-seeded
  assert.ok(siteConfigs.has("avocado-hub::dev"))
})

test("applyPersistedState: skips invalid published pages", () => {
  const sizeBefore = publishedPages.size
  applyPersistedState({
    publishedPages: [null as any, { noSlug: true } as any, { slug: "/valid", id: "x", title: "V", updatedAt: "2026-01-01", blocks: [] }]
  })
  assert.ok(publishedPages.has("/valid"))
})

test("applyPersistedState: enforces chat history max turns", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `msg-${i}`
  }))
  applyPersistedState({ chatHistory: { session1: history } })
  assert.ok(chatHistoryBySession.get("session1")!.length <= CHAT_HISTORY_MAX_TURNS)
})

test("applyPersistedState: enforces recent edits limit (max 10)", () => {
  const edits = Array.from({ length: 15 }, (_, i) => ({
    slug: "/",
    summary: `edit-${i}`,
    ops: [] as any[],
    at: "2026-01-01"
  }))
  applyPersistedState({ recentEdits: { session1: edits } })
  assert.ok(recentEdits.get("session1")!.length <= 10)
})

// ---------------------------------------------------------------------------
// pushChatHistory / pushRecentEdit / getRecentEdits
// ---------------------------------------------------------------------------

test("pushChatHistory: appends and trims to max turns", () => {
  const session = "chat-test-" + Date.now()
  chatHistoryBySession.delete(session)
  for (let i = 0; i < 10; i++) {
    pushChatHistory(session, `user-${i}`, `assistant-${i}`)
  }
  const history = chatHistoryBySession.get(session)!
  assert.ok(history.length <= CHAT_HISTORY_MAX_TURNS)
})

test("pushRecentEdit + getRecentEdits: filters by slug and limits to 3", () => {
  const session = "recent-edit-test-" + Date.now()
  recentEdits.delete(session)
  for (let i = 0; i < 5; i++) {
    pushRecentEdit(session, { slug: "/", summary: `edit-${i}`, ops: [] })
  }
  pushRecentEdit(session, { slug: "/about", summary: "about edit", ops: [] })

  const homeEdits = getRecentEdits(session, "/")
  assert.ok(homeEdits.length <= 3)
  assert.ok(homeEdits.every((e) => e.summary.startsWith("edit-")))

  const aboutEdits = getRecentEdits(session, "/about")
  assert.equal(aboutEdits.length, 1)
})

// ---------------------------------------------------------------------------
// issueTouchedSlugs — set/get, dedupe, roundtrip through applyPersistedState
// ---------------------------------------------------------------------------

test("setIssueTouchedSlugs: stores slugs and dedupes, empty key is ignored", () => {
  issueTouchedSlugsByKey.clear()
  setIssueTouchedSlugs("SCRUM-99", ["/test", "/test", "/about", "", "other"])
  const stored = getIssueTouchedSlugs("SCRUM-99")
  assert.deepEqual(stored.sort(), ["/about", "/test", "other"])

  setIssueTouchedSlugs("", ["/whatever"])
  assert.equal(issueTouchedSlugsByKey.has(""), false)
})

test("getIssueTouchedSlugs: returns empty array for unknown key", () => {
  assert.deepEqual(getIssueTouchedSlugs("DOES-NOT-EXIST"), [])
})

test("applyPersistedState: roundtrips issueTouchedSlugs", () => {
  applyPersistedState({
    issueTouchedSlugs: {
      "SCRUM-17": { slugs: ["/test"], updatedAt: "2026-04-19T00:00:00Z" },
      "SCRUM-18": { slugs: ["/", "/about"], updatedAt: "2026-04-19T01:00:00Z" },
    },
  })
  assert.deepEqual(getIssueTouchedSlugs("SCRUM-17"), ["/test"])
  assert.deepEqual(getIssueTouchedSlugs("SCRUM-18"), ["/", "/about"])
})

test("applyPersistedState: skips malformed issueTouchedSlugs entries", () => {
  issueTouchedSlugsByKey.clear()
  applyPersistedState({
    issueTouchedSlugs: {
      "GOOD": { slugs: ["/ok"], updatedAt: "2026-04-19T00:00:00Z" },
      "BAD-NO-SLUGS": {} as any,
      "BAD-WRONG-TYPE": "nope" as any,
      "BAD-NON-STRING-SLUG": { slugs: [123, null, "/real"] as any, updatedAt: "x" },
    },
  })
  assert.deepEqual(getIssueTouchedSlugs("GOOD"), ["/ok"])
  assert.equal(issueTouchedSlugsByKey.has("BAD-NO-SLUGS"), false)
  assert.equal(issueTouchedSlugsByKey.has("BAD-WRONG-TYPE"), false)
  assert.deepEqual(getIssueTouchedSlugs("BAD-NON-STRING-SLUG"), ["/real"])
})

// ---------------------------------------------------------------------------
// evictStaleEphemeralMaps
// ---------------------------------------------------------------------------

function makeStalePlan(id: string): PendingApprovalPlan {
  return {
    id,
    createdAt: new Date(0).toISOString(), // epoch — always older than 1hr TTL
    promptHash: "hash",
    requestedSlug: "/",
    effectiveSlug: "/",
    summary: "test plan",
    source: "openai",
    modelUsed: "gpt-4o",
    modelKey: "fast",
    plan: { intent: "edit_plan", ops: [] },
    stepLabels: [],
    currentStep: 0,
    totalSteps: 0,
    originalMessage: "test",
    siteContextBlock: null,
  } as unknown as PendingApprovalPlan
}

function makeStalePublishTracker(session: string): PublishTracker {
  return {
    session,
    status: "triggered",
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), // epoch — always older than 24hr TTL
    slugs: ["/"],
  }
}

test("evictStaleEphemeralMaps: evicts approval plan older than TTL", () => {
  pendingApprovalPlanBySession.clear()
  pendingApprovalPlanBySession.set("stale-session", makeStalePlan("plan-1"))
  evictStaleEphemeralMaps()
  assert.equal(pendingApprovalPlanBySession.has("stale-session"), false)
  pendingApprovalPlanBySession.clear()
})

test("evictStaleEphemeralMaps: retains approval plan within TTL", () => {
  pendingApprovalPlanBySession.clear()
  const freshPlan = { ...makeStalePlan("plan-fresh"), createdAt: new Date().toISOString() }
  pendingApprovalPlanBySession.set("fresh-session", freshPlan as unknown as PendingApprovalPlan)
  evictStaleEphemeralMaps()
  assert.equal(pendingApprovalPlanBySession.has("fresh-session"), true)
  pendingApprovalPlanBySession.clear()
})

test("evictStaleEphemeralMaps: evicts publish status older than TTL", () => {
  publishStatusBySession.clear()
  publishStatusBySession.set("stale-pub", makeStalePublishTracker("stale-pub"))
  evictStaleEphemeralMaps()
  assert.equal(publishStatusBySession.has("stale-pub"), false)
  publishStatusBySession.clear()
})

test("evictStaleEphemeralMaps: retains publish status within TTL", () => {
  publishStatusBySession.clear()
  const freshTracker = { ...makeStalePublishTracker("fresh-pub"), updatedAt: new Date().toISOString() }
  publishStatusBySession.set("fresh-pub", freshTracker)
  evictStaleEphemeralMaps()
  assert.equal(publishStatusBySession.has("fresh-pub"), true)
  publishStatusBySession.clear()
})

test("evictStaleEphemeralMaps: caps size-only maps at EPHEMERAL_MAP_CAP (500)", () => {
  continuationChainBySession.clear()
  for (let i = 0; i < 502; i++) {
    continuationChainBySession.set(`session-${i}`, {} as any)
  }
  evictStaleEphemeralMaps()
  assert.equal(continuationChainBySession.size, 500)
  // Oldest entries (lowest i) are dropped; newest survive
  assert.equal(continuationChainBySession.has("session-0"), false)
  assert.equal(continuationChainBySession.has("session-1"), false)
  assert.equal(continuationChainBySession.has("session-501"), true)
  continuationChainBySession.clear()
})
