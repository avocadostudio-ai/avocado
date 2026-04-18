import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEvalCandidateStore } from "./eval-candidate-store.js"
import type { PageDoc } from "@ai-site-editor/shared"

const silentLogger = { info: () => undefined, error: () => undefined }

function tempFilePath() {
  const dir = mkdtempSync(join(tmpdir(), "eval-candidate-"))
  return { file: join(dir, "candidates.ndjson"), dir }
}

const samplePages: PageDoc[] = [
  { id: "p_home", slug: "/", title: "Home", updatedAt: "2026-03-03T00:00:00.000Z", blocks: [{ id: "b_hero", type: "Hero", props: { heading: "Hi" } }] }
]

test("start + finalize roundtrip persists and returns merged record", async () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: true, ttlDays: 7, logger: silentLogger })
    store.start({
      id: "trace-1",
      session: "s1",
      slug: "/",
      prompt: "make the hero bolder",
      fixture: samplePages
    })
    const record = store.finalize("trace-1", { outcome: "applied", opTypes: ["update_props"], opCount: 1, plannerTier: "full_llm" })
    assert.ok(record, "expected finalize to return a record")
    assert.equal(record!.outcome, "applied")
    assert.deepEqual(record!.opTypes, ["update_props"])
    assert.equal(record!.prompt, "make the hero bolder")
    assert.equal(record!.fixture.length, 1)

    await store.flushNow()
    assert.ok(existsSync(file), "ndjson should have been written")
    const raw = readFileSync(file, "utf8").trim().split("\n")
    assert.equal(raw.length, 1)
    const parsed = JSON.parse(raw[0]!)
    assert.equal(parsed.id, "trace-1")
    assert.equal(parsed.outcome, "applied")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("finalize without a matching start is a no-op", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: false, ttlDays: 7, logger: silentLogger })
    const result = store.finalize("missing", { outcome: "applied" })
    assert.equal(result, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("cancel removes an opened candidate so later finalize is a no-op", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: false, ttlDays: 7, logger: silentLogger })
    store.start({ id: "trace-x", session: "s1", slug: "/", prompt: "hi", fixture: samplePages })
    store.cancel("trace-x")
    const result = store.finalize("trace-x", { outcome: "applied" })
    assert.equal(result, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadFromDisk drops records older than ttlDays", async () => {
  const { file, dir } = tempFilePath()
  try {
    mkdirSync(dir, { recursive: true })
    const fresh = { id: "new", at: new Date().toISOString(), session: "s1", slug: "/", prompt: "fresh", fixture: samplePages, outcome: "applied" }
    const stale = { id: "old", at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), session: "s1", slug: "/", prompt: "stale", fixture: samplePages, outcome: "applied" }
    writeFileSync(file, `${JSON.stringify(fresh)}\n${JSON.stringify(stale)}\n`, "utf8")

    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: true, ttlDays: 7, logger: silentLogger })
    await store.loadFromDisk()

    const { rows, total } = store.list({ limit: 100 })
    assert.equal(total, 1)
    assert.equal(rows[0]!.id, "new")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("list filters by session and outcome", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: false, ttlDays: 7, logger: silentLogger })
    store.start({ id: "a", session: "s1", slug: "/", prompt: "p1", fixture: samplePages })
    store.finalize("a", { outcome: "applied" })
    store.start({ id: "b", session: "s2", slug: "/", prompt: "p2", fixture: samplePages })
    store.finalize("b", { outcome: "needs_clarification" })
    store.start({ id: "c", session: "s1", slug: "/", prompt: "p3", fixture: samplePages })
    store.finalize("c", { outcome: "needs_clarification" })

    assert.equal(store.list({ session: "s1" }).total, 2)
    assert.equal(store.list({ outcome: "applied" }).total, 1)
    assert.equal(store.list({ session: "s1", outcome: "needs_clarification" }).total, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buffer limit drops oldest records", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 2, persistEnabled: false, ttlDays: 7, logger: silentLogger })
    for (const id of ["a", "b", "c"]) {
      store.start({ id, session: "s1", slug: "/", prompt: id, fixture: samplePages })
      store.finalize(id, { outcome: "applied" })
    }
    const { rows, total } = store.list({ limit: 10 })
    assert.equal(total, 2)
    assert.deepEqual(rows.map((r) => r.id), ["b", "c"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("get returns the most recent candidate by id", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createEvalCandidateStore({ filePath: file, limit: 100, persistEnabled: false, ttlDays: 7, logger: silentLogger })
    store.start({ id: "trace-1", session: "s1", slug: "/", prompt: "hi", fixture: samplePages })
    store.finalize("trace-1", { outcome: "applied" })
    const found = store.get("trace-1")
    assert.ok(found)
    assert.equal(found!.outcome, "applied")
    assert.equal(store.get("missing"), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
