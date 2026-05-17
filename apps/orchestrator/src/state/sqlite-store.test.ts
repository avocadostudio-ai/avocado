import test from "node:test"
import assert from "node:assert/strict"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve as resolvePath } from "node:path"
import type { PageDoc } from "@avocadostudio-ai/shared"
import {
  SqliteStore,
  HISTORY_DEPTH_CAP,
  VERSION_LOG_CAP,
  RECENT_EDITS_CAP,
  CHAT_HISTORY_CAP,
  PUBLISH_LOG_CAP,
  type PublishLogEntry,
} from "./sqlite-store.js"

function makePage(slug: string, title = "Hello"): PageDoc {
  return {
    slug,
    title,
    blocks: [
      {
        id: `b-${slug}`,
        type: "RichText",
        props: { content: [{ type: "paragraph", text: title }] },
      },
    ],
  } as unknown as PageDoc
}

function makeStore() {
  return new SqliteStore({ file: ":memory:" })
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
test("pages: set/get/remove round-trip for draft and published kinds", () => {
  const store = makeStore()
  try {
    const page = makePage("/")
    store.setPage("s1", page, "draft")
    store.setPage("s1", { ...page, title: "Published" }, "published")

    assert.deepEqual(store.getPage("s1", "/", "draft")?.title, "Hello")
    assert.deepEqual(store.getPage("s1", "/", "published")?.title, "Published")
    assert.equal(store.getPage("s1", "/missing"), null)

    store.removePage("s1", "/", "draft")
    assert.equal(store.getPage("s1", "/", "draft"), null)
    // Published copy untouched
    assert.equal(store.getPage("s1", "/", "published")?.title, "Published")
  } finally {
    store.close()
  }
})

test("pages: listPages returns all pages for a session+kind sorted by slug", () => {
  const store = makeStore()
  try {
    store.setPage("s1", makePage("/b"))
    store.setPage("s1", makePage("/a"))
    store.setPage("s1", makePage("/c"))
    store.setPage("s2", makePage("/x"))

    const s1 = store.listPages("s1", "draft")
    assert.deepEqual(s1.map((p) => p.slug), ["/a", "/b", "/c"])
    const s2 = store.listPages("s2", "draft")
    assert.deepEqual(s2.map((p) => p.slug), ["/x"])
  } finally {
    store.close()
  }
})

test("pages: upsert replaces existing doc", () => {
  const store = makeStore()
  try {
    store.setPage("s1", makePage("/", "v1"))
    store.setPage("s1", makePage("/", "v2"))
    assert.equal(store.getPage("s1", "/")?.title, "v2")
  } finally {
    store.close()
  }
})

test("pages: listDraftSessions returns distinct sessions", () => {
  const store = makeStore()
  try {
    store.setPage("s1", makePage("/"))
    store.setPage("s1", makePage("/a"))
    store.setPage("s2", makePage("/"))
    store.setPage("s3", makePage("/"), "published") // published-only, excluded
    assert.deepEqual(store.listDraftSessions(), ["s1", "s2"])
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
test("history: push/pop behaves as a LIFO stack", () => {
  const store = makeStore()
  try {
    store.pushHistory("s1", "/", "undo", makePage("/", "v1"))
    store.pushHistory("s1", "/", "undo", makePage("/", "v2"))
    store.pushHistory("s1", "/", "undo", null)

    assert.equal(store.popHistory("s1", "/", "undo"), null)
    assert.equal(store.popHistory("s1", "/", "undo")?.title, "v2")
    assert.equal(store.popHistory("s1", "/", "undo")?.title, "v1")
    assert.equal(store.popHistory("s1", "/", "undo"), undefined)
  } finally {
    store.close()
  }
})

test("history: undo and redo stacks are independent", () => {
  const store = makeStore()
  try {
    store.pushHistory("s1", "/", "undo", makePage("/", "u1"))
    store.pushHistory("s1", "/", "redo", makePage("/", "r1"))
    assert.equal(store.popHistory("s1", "/", "undo")?.title, "u1")
    assert.equal(store.popHistory("s1", "/", "redo")?.title, "r1")
  } finally {
    store.close()
  }
})

test("history: clearHistory removes only the requested direction", () => {
  const store = makeStore()
  try {
    store.pushHistory("s1", "/", "undo", makePage("/", "u1"))
    store.pushHistory("s1", "/", "redo", makePage("/", "r1"))
    store.clearHistory("s1", "/", "redo")
    assert.equal(store.popHistory("s1", "/", "redo"), undefined)
    assert.equal(store.popHistory("s1", "/", "undo")?.title, "u1")
  } finally {
    store.close()
  }
})

test(`history: depth is capped at HISTORY_DEPTH_CAP (${HISTORY_DEPTH_CAP})`, () => {
  const store = makeStore()
  try {
    for (let i = 0; i < HISTORY_DEPTH_CAP + 10; i++) {
      store.pushHistory("s1", "/", "undo", makePage("/", `v${i}`))
    }
    const all = store.listHistory("s1", "/", "undo")
    assert.equal(all.length, HISTORY_DEPTH_CAP)
    // Oldest dropped, newest kept
    assert.equal((all[0] as PageDoc).title, "v10")
    assert.equal((all.at(-1) as PageDoc).title, `v${HISTORY_DEPTH_CAP + 9}`)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Version counter
// ---------------------------------------------------------------------------
test("version: getVersion defaults to 0; bumpVersion returns sequential ints", () => {
  const store = makeStore()
  try {
    assert.equal(store.getVersion("s1"), 0)
    assert.equal(store.bumpVersion("s1"), 1)
    assert.equal(store.bumpVersion("s1"), 2)
    assert.equal(store.bumpVersion("s2"), 1)
    assert.equal(store.getVersion("s1"), 2)
    store.setVersion("s1", 42)
    assert.equal(store.getVersion("s1"), 42)
    assert.equal(store.bumpVersion("s1"), 43)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Version log
// ---------------------------------------------------------------------------
test(`version_log: caps at VERSION_LOG_CAP (${VERSION_LOG_CAP}) per session`, () => {
  const store = makeStore()
  try {
    for (let i = 0; i < VERSION_LOG_CAP + 5; i++) {
      store.pushVersionLog("s1", {
        version: i,
        slug: "/",
        summary: `edit ${i}`,
        opTypes: ["update_props"],
        opCount: 1,
        at: new Date(i).toISOString(),
        source: "chat",
      })
    }
    const all = store.listVersionLog("s1", undefined, 1000)
    assert.equal(all.length, VERSION_LOG_CAP)
    assert.equal(all[0].version, 5)
    assert.equal(all.at(-1)?.version, VERSION_LOG_CAP + 4)
  } finally {
    store.close()
  }
})

test("version_log: filter by slug uses json_extract", () => {
  const store = makeStore()
  try {
    const base = { summary: "", opTypes: [], opCount: 0, at: "", source: "chat" as const }
    store.pushVersionLog("s1", { ...base, version: 1, slug: "/" })
    store.pushVersionLog("s1", { ...base, version: 2, slug: "/about" })
    store.pushVersionLog("s1", { ...base, version: 3, slug: "/" })
    const home = store.listVersionLog("s1", "/")
    assert.deepEqual(home.map((e) => e.version), [1, 3])
    const about = store.listVersionLog("s1", "/about")
    assert.deepEqual(about.map((e) => e.version), [2])
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Recent edits
// ---------------------------------------------------------------------------
test(`recent_edits: caps at RECENT_EDITS_CAP (${RECENT_EDITS_CAP}) per session`, () => {
  const store = makeStore()
  try {
    for (let i = 0; i < RECENT_EDITS_CAP + 3; i++) {
      store.pushRecentEdit("s1", {
        slug: "/",
        summary: `edit ${i}`,
        ops: [],
        at: new Date(i).toISOString(),
      })
    }
    const list = store.listRecentEdits("s1")
    assert.equal(list.length, RECENT_EDITS_CAP)
    assert.equal(list[0].summary, "edit 3")
    assert.equal(list.at(-1)?.summary, `edit ${RECENT_EDITS_CAP + 2}`)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------
test(`chat_history: caps at CHAT_HISTORY_CAP (${CHAT_HISTORY_CAP}) messages per session`, () => {
  const store = makeStore()
  try {
    for (let i = 0; i < CHAT_HISTORY_CAP + 4; i++) {
      store.pushChatMessage("s1", i % 2 === 0 ? "user" : "assistant", `m${i}`)
    }
    const list = store.listChatHistory("s1")
    assert.equal(list.length, CHAT_HISTORY_CAP)
    assert.equal(list[0].content, "m4")
    assert.equal(list.at(-1)?.content, `m${CHAT_HISTORY_CAP + 3}`)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Publish log
// ---------------------------------------------------------------------------
function makePublishEntry(overrides: Partial<PublishLogEntry> = {}): PublishLogEntry {
  const at = overrides.at ?? new Date().toISOString()
  return {
    id: overrides.id ?? `pub-${Math.random().toString(36).slice(2, 10)}`,
    session: overrides.session ?? "s1",
    siteId: overrides.siteId ?? "avocado-stories",
    target: overrides.target ?? "site-contract",
    status: overrides.status ?? "triggered",
    at,
    updatedAt: overrides.updatedAt ?? at,
    summary: overrides.summary ?? "Published Home",
    pageCount: overrides.pageCount ?? 1,
    slugs: overrides.slugs ?? ["/"],
    ...overrides,
  }
}

test("publish_log: push + list round-trips full entry shape", () => {
  const store = makeStore()
  try {
    const entry = makePublishEntry({
      id: "pub-1",
      commit: "abc1234",
      deploymentId: "dpl_42",
      deploymentUrl: "https://example.vercel.app",
      inspectUrl: "https://vercel.com/inspect/dpl_42",
      slugs: ["/", "/pricing"],
      pageCount: 2,
    })
    store.pushPublishLog(entry)
    const list = store.listPublishLog("s1")
    assert.equal(list.length, 1)
    assert.deepEqual(list[0], entry)
  } finally {
    store.close()
  }
})

test(`publish_log: caps at PUBLISH_LOG_CAP (${PUBLISH_LOG_CAP}) per session`, () => {
  const store = makeStore()
  try {
    for (let i = 0; i < PUBLISH_LOG_CAP + 50; i++) {
      store.pushPublishLog(
        makePublishEntry({
          id: `pub-${i}`,
          summary: `pub ${i}`,
          at: new Date(i).toISOString(),
        })
      )
    }
    const list = store.listPublishLog("s1", 10_000)
    assert.equal(list.length, PUBLISH_LOG_CAP)
    // Oldest 50 dropped; first kept is index 50
    assert.equal(list[0].summary, "pub 50")
    assert.equal(list.at(-1)?.summary, `pub ${PUBLISH_LOG_CAP + 49}`)
  } finally {
    store.close()
  }
})

test("publish_log: per-session isolation", () => {
  const store = makeStore()
  try {
    store.pushPublishLog(makePublishEntry({ id: "a", session: "s1", summary: "s1 pub" }))
    store.pushPublishLog(makePublishEntry({ id: "b", session: "s2", summary: "s2 pub" }))
    assert.deepEqual(store.listPublishLog("s1").map((e) => e.summary), ["s1 pub"])
    assert.deepEqual(store.listPublishLog("s2").map((e) => e.summary), ["s2 pub"])
    assert.deepEqual(store.listPublishLogSessions().sort(), ["s1", "s2"])
  } finally {
    store.close()
  }
})

test("publish_log: updatePublishLogById patches status, bumps updatedAt, preserves at/id/session", () => {
  const store = makeStore()
  try {
    const at = "2026-05-17T10:00:00.000Z"
    store.pushPublishLog(
      makePublishEntry({ id: "pub-1", status: "triggered", at, updatedAt: at, deploymentId: "dpl_1" })
    )
    const before = store.getPublishLogById("pub-1")
    assert.equal(before?.status, "triggered")

    const updated = store.updatePublishLogById("pub-1", {
      status: "success",
      deploymentUrl: "https://done.vercel.app",
    })
    assert.equal(updated?.status, "success")
    assert.equal(updated?.deploymentUrl, "https://done.vercel.app")
    assert.equal(updated?.at, at, "at should be immutable")
    assert.equal(updated?.id, "pub-1", "id should be immutable")
    assert.equal(updated?.session, "s1", "session should be immutable")
    assert.notEqual(updated?.updatedAt, at, "updatedAt should be bumped")

    // List reflects the update (hoisted column + JSON in sync)
    const list = store.listPublishLog("s1")
    assert.equal(list[0].status, "success")
    assert.equal(list[0].deploymentUrl, "https://done.vercel.app")
  } finally {
    store.close()
  }
})

test("publish_log: updatePublishLogById returns null for unknown id", () => {
  const store = makeStore()
  try {
    const result = store.updatePublishLogById("missing", { status: "success" })
    assert.equal(result, null)
  } finally {
    store.close()
  }
})

test("publish_log: getPublishLogByDeploymentId resolves async status correlation", () => {
  const store = makeStore()
  try {
    store.pushPublishLog(makePublishEntry({ id: "old", deploymentId: "dpl_1", summary: "old" }))
    store.pushPublishLog(makePublishEntry({ id: "new", deploymentId: "dpl_1", summary: "new" }))
    // Should pick the most recent matching deployment id
    const row = store.getPublishLogByDeploymentId("s1", "dpl_1")
    assert.equal(row?.summary, "new")
    assert.equal(row?.id, "new")
    assert.equal(store.getPublishLogByDeploymentId("s1", "missing"), null)
  } finally {
    store.close()
  }
})

test("publish_log: getMostRecentTriggeredPublishLog falls back when deploymentId missing", () => {
  const store = makeStore()
  try {
    store.pushPublishLog(makePublishEntry({ id: "a", status: "success", summary: "old success" }))
    store.pushPublishLog(makePublishEntry({ id: "b", status: "triggered", summary: "pending" }))
    const row = store.getMostRecentTriggeredPublishLog("s1")
    assert.equal(row?.id, "b")
    assert.equal(row?.summary, "pending")
  } finally {
    store.close()
  }
})

test("publish_log: ordering preserves insertion order", () => {
  const store = makeStore()
  try {
    for (let i = 0; i < 5; i++) {
      store.pushPublishLog(makePublishEntry({ id: `p${i}`, summary: `pub ${i}` }))
    }
    const list = store.listPublishLog("s1")
    assert.deepEqual(list.map((e) => e.summary), ["pub 0", "pub 1", "pub 2", "pub 3", "pub 4"])
  } finally {
    store.close()
  }
})

test("publish_log: list limit returns latest N", () => {
  const store = makeStore()
  try {
    for (let i = 0; i < 10; i++) {
      store.pushPublishLog(makePublishEntry({ id: `p${i}`, summary: `pub ${i}` }))
    }
    const last3 = store.listPublishLog("s1", 3)
    assert.deepEqual(last3.map((e) => e.summary), ["pub 7", "pub 8", "pub 9"])
  } finally {
    store.close()
  }
})

test("publish_log: survives close/reopen with hydrated rows", () => {
  const tmp = resolvePath(tmpdir(), `sqlite-publish-log-${process.pid}-${Date.now()}.db`)
  const s1 = new SqliteStore({ file: tmp, wal: false })
  s1.pushPublishLog(makePublishEntry({ id: "pub-A", summary: "first" }))
  s1.pushPublishLog(makePublishEntry({ id: "pub-B", summary: "second" }))
  s1.updatePublishLogById("pub-A", { status: "success" })
  s1.close()

  const s2 = new SqliteStore({ file: tmp, wal: false })
  try {
    const list = s2.listPublishLog("s1")
    assert.equal(list.length, 2)
    assert.equal(list[0].status, "success")
    assert.equal(list[0].summary, "first")
    assert.equal(list[1].status, "triggered")
    assert.deepEqual(s2.listPublishLogSessions(), ["s1"])
  } finally {
    s2.close()
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
})

// ---------------------------------------------------------------------------
// Site configs
// ---------------------------------------------------------------------------
test("site_configs: set/get/list", () => {
  const store = makeStore()
  try {
    store.setSiteConfig("avocado-hub::dev", { name: "Hub", logo: "/a.svg" })
    store.setSiteConfig("other::dev", { name: "Other" })
    assert.deepEqual(store.getSiteConfig("avocado-hub::dev"), { name: "Hub", logo: "/a.svg" })
    assert.equal(store.getSiteConfig("missing"), null)
    // Upsert overwrites
    store.setSiteConfig("avocado-hub::dev", { name: "Hub v2" })
    assert.deepEqual(store.getSiteConfig("avocado-hub::dev"), { name: "Hub v2" })
    const all = store.listSiteConfigs()
    assert.equal(all.length, 2)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Issue-touched slugs
// ---------------------------------------------------------------------------
test("issue_touched: set/get/list and cap trims oldest", () => {
  const store = makeStore()
  try {
    for (let i = 0; i < 5; i++) {
      store.setIssueTouched(
        `ISSUE-${i}`,
        { slugs: [`/p${i}`], updatedAt: new Date(i).toISOString() },
        3 // cap at 3
      )
    }
    const list = store.listIssueTouched()
    assert.equal(list.length, 3)
    const keys = list.map((e) => e.issueKey).sort()
    assert.deepEqual(keys, ["ISSUE-2", "ISSUE-3", "ISSUE-4"])
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
test("transaction: rolls back on throw", () => {
  const store = makeStore()
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.setPage("s1", makePage("/"))
        throw new Error("nope")
      })
    )
    assert.equal(store.getPage("s1", "/"), null)
  } finally {
    store.close()
  }
})

test("transaction: commits on success", () => {
  const store = makeStore()
  try {
    const result = store.transaction(() => {
      store.setPage("s1", makePage("/"))
      store.bumpVersion("s1")
      return "ok"
    })
    assert.equal(result, "ok")
    assert.equal(store.getPage("s1", "/")?.slug, "/")
    assert.equal(store.getVersion("s1"), 1)
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------
test("schema: file-backed DB survives close/reopen", () => {
  const tmp = resolvePath(tmpdir(), `sqlite-store-test-${process.pid}-${Date.now()}.db`)
  const s1 = new SqliteStore({ file: tmp, wal: false })
  s1.setPage("s1", makePage("/"))
  s1.bumpVersion("s1")
  s1.close()

  const s2 = new SqliteStore({ file: tmp, wal: false })
  try {
    assert.equal(s2.getPage("s1", "/")?.slug, "/")
    assert.equal(s2.getVersion("s1"), 1)
  } finally {
    s2.close()
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
})
