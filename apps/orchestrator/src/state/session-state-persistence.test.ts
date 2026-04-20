/**
 * Integration test for Phase 2 persistence: verifies the in-memory Maps
 * survive a persist -> clear -> hydrate cycle through the SqliteStore
 * singleton, and that the legacy JSON file migrates on startup.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import type { FastifyBaseLogger } from "fastify"
import type { PageDoc } from "@ai-site-editor/shared"
import {
  applyPersistedState,
  draftPages,
  historyUndo,
  historyRedo,
  versions,
  versionLog,
  recentEdits,
  chatHistoryBySession,
  siteConfigs,
  issueTouchedSlugsByKey,
  loadStateFromDisk,
  persistStateNow,
  publishedPages,
  type PersistedState,
} from "./session-state.js"
import { resetStore } from "./sqlite-store-singleton.js"

const silentLogger: FastifyBaseLogger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
  child() { return this },
  level: "silent",
} as unknown as FastifyBaseLogger

function makePage(slug: string, title = "Hi"): PageDoc {
  return {
    id: `p-${slug}`,
    slug,
    title,
    updatedAt: "2026-01-01",
    blocks: [{ id: `b-${slug}`, type: "RichText", props: { content: [{ type: "paragraph", text: title }] } }],
  } as unknown as PageDoc
}

function clearAllMaps() {
  publishedPages.clear()
  draftPages.clear()
  historyUndo.clear()
  historyRedo.clear()
  versions.clear()
  versionLog.clear()
  recentEdits.clear()
  chatHistoryBySession.clear()
  siteConfigs.clear()
  issueTouchedSlugsByKey.clear()
}

/** Give each test an isolated SQLite file + legacy JSON sibling path. */
async function withTempDb<T>(
  fn: (dbFile: string, jsonFile: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(resolve(tmpdir(), "orch-persist-"))
  const dbFile = resolve(dir, "orchestrator.db")
  const jsonFile = resolve(dir, "orchestrator-state.json")
  const prevDb = process.env.ORCHESTRATOR_DB_FILE
  const prevJson = process.env.ORCHESTRATOR_STATE_FILE
  process.env.ORCHESTRATOR_DB_FILE = dbFile
  process.env.ORCHESTRATOR_STATE_FILE = jsonFile
  resetStore()
  try {
    return await fn(dbFile, jsonFile)
  } finally {
    resetStore()
    if (prevDb === undefined) delete process.env.ORCHESTRATOR_DB_FILE
    else process.env.ORCHESTRATOR_DB_FILE = prevDb
    if (prevJson === undefined) delete process.env.ORCHESTRATOR_STATE_FILE
    else process.env.ORCHESTRATOR_STATE_FILE = prevJson
    rmSync(dir, { recursive: true, force: true })
  }
}

test("persistStateNow + loadStateFromDisk round-trips all state maps via SQLite", async () => {
  await withTempDb(async (dbFile) => {
    clearAllMaps()
    // Seed the Maps
    publishedPages.set("/", makePage("/", "Published"))
    const sessionId = "site-a::dev"
    draftPages.set(sessionId, new Map([["/", makePage("/", "Draft v1")]]))
    const undoForSession = new Map<string, (PageDoc | null)[]>([
      ["/", [makePage("/", "old1"), null, makePage("/", "old3")]],
    ])
    historyUndo.set(sessionId, undoForSession)
    historyRedo.set(sessionId, new Map([["/", [makePage("/", "future")]]]))
    versions.set(sessionId, 7)
    versionLog.set(sessionId, [{
      version: 1, slug: "/", summary: "first", opTypes: ["update_props"], opCount: 1,
      at: "2026-01-01T00:00:00Z", source: "chat",
    }])
    recentEdits.set(sessionId, [{ slug: "/", summary: "r1", ops: [], at: "2026-01-01" }])
    chatHistoryBySession.set(sessionId, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])
    siteConfigs.set(sessionId, { name: "A" })
    issueTouchedSlugsByKey.set("PROJ-1", { slugs: ["/"], updatedAt: "2026-01-01" })

    await persistStateNow(silentLogger)
    assert.ok(existsSync(dbFile), "db file was created")

    // Wipe all maps and reload from SQLite
    clearAllMaps()
    resetStore() // force a fresh connection to simulate process restart
    await loadStateFromDisk(silentLogger)

    assert.equal(publishedPages.get("/")?.title, "Published", "published page survived")
    assert.equal(draftPages.get(sessionId)?.get("/")?.title, "Draft v1")
    assert.deepEqual(
      (historyUndo.get(sessionId)?.get("/") ?? []).map((s) => s?.title ?? null),
      ["old1", null, "old3"],
      "undo stack with null gaps round-trips"
    )
    assert.equal(historyRedo.get(sessionId)?.get("/")?.[0]?.title, "future")
    assert.equal(versions.get(sessionId), 7)
    assert.equal(versionLog.get(sessionId)?.[0]?.summary, "first")
    assert.equal(recentEdits.get(sessionId)?.[0]?.summary, "r1")
    assert.equal(chatHistoryBySession.get(sessionId)?.length, 2)
    assert.equal(siteConfigs.get(sessionId)?.name, "A")
    assert.deepEqual(issueTouchedSlugsByKey.get("PROJ-1")?.slugs, ["/"])
  })
})

test("loadStateFromDisk migrates a legacy JSON file into SQLite and archives it", async () => {
  await withTempDb(async (dbFile, jsonFile) => {
    clearAllMaps()
    const page = makePage("/", "FromJson")
    const payload: Partial<PersistedState> = {
      publishedPages: [page],
      draftPages: { "legacy-site::dev": { "/": page } },
      historyUndo: {}, historyRedo: {},
      versions: { "legacy-site::dev": 3 },
      recentEdits: {},
      chatHistory: {},
      siteConfigs: { "legacy-site::dev": { name: "Legacy" } },
    }
    writeFileSync(jsonFile, JSON.stringify(payload), "utf8")

    await loadStateFromDisk(silentLogger)

    assert.equal(publishedPages.get("/")?.title, "FromJson", "json import populated published")
    assert.equal(draftPages.get("legacy-site::dev")?.get("/")?.title, "FromJson")
    assert.equal(versions.get("legacy-site::dev"), 3)
    assert.equal(siteConfigs.get("legacy-site::dev")?.name, "Legacy")

    assert.ok(existsSync(dbFile), "sqlite file was created during migration")
    assert.ok(!existsSync(jsonFile), "legacy json was renamed")
    const siblings = readdirSync(resolve(jsonFile, ".."))
    const archived = siblings.find((n) => n.startsWith("orchestrator-state.json.migrated-"))
    assert.ok(archived, "legacy json was archived with .migrated- suffix")

    // Second load must hydrate directly from SQLite (not the archived json).
    clearAllMaps()
    resetStore()
    await loadStateFromDisk(silentLogger)
    assert.equal(publishedPages.get("/")?.title, "FromJson", "second load came from SQLite")
  })
})

test("loadStateFromDisk is a no-op when neither SQLite nor JSON exist", async () => {
  await withTempDb(async () => {
    clearAllMaps()
    // Re-apply default seed via applyPersistedState({}) — it re-seeds the
    // default siteConfig.
    applyPersistedState({})
    const sizeBefore = siteConfigs.size
    await loadStateFromDisk(silentLogger)
    // Maps untouched (except we just default-seeded); no throw.
    assert.equal(siteConfigs.size, sizeBefore)
  })
})
