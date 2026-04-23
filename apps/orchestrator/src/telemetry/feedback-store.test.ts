import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFeedbackStore } from "./feedback-store.js"

const silentLogger = { info: () => undefined, error: () => undefined }

function tempFilePath() {
  const dir = mkdtempSync(join(tmpdir(), "feedback-store-"))
  return { file: join(dir, "feedback.ndjson"), dir }
}

test("push → flushNow writes ndjson and list returns the entry", async () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createFeedbackStore({ filePath: file, limit: 100, logger: silentLogger })
    store.push({ id: "id-1", at: "2026-04-23T00:00:00.000Z", traceId: "trace-1", session: "s1", rating: "down", note: "oops" })
    await store.flushNow()

    assert.ok(existsSync(file))
    const raw = readFileSync(file, "utf8").trim().split("\n")
    assert.equal(raw.length, 1)
    const parsed = JSON.parse(raw[0]!)
    assert.equal(parsed.rating, "down")
    assert.equal(parsed.note, "oops")

    const listed = store.list({})
    assert.equal(listed.total, 1)
    assert.equal(listed.rows[0]!.id, "id-1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadFromDisk restores trailing entries up to limit", async () => {
  const { file, dir } = tempFilePath()
  try {
    const seed = createFeedbackStore({ filePath: file, limit: 100, logger: silentLogger })
    for (let i = 0; i < 5; i++) {
      seed.push({ id: `id-${i}`, at: new Date().toISOString(), traceId: `t-${i}`, session: "s1", rating: i % 2 === 0 ? "up" : "down" })
    }
    await seed.flushNow()

    const reload = createFeedbackStore({ filePath: file, limit: 100, logger: silentLogger })
    await reload.loadFromDisk()
    const listed = reload.list({})
    assert.equal(listed.total, 5)

    const onlyDown = reload.list({ rating: "down" })
    assert.equal(onlyDown.total, 2)

    const bySession = reload.list({ session: "s1" })
    assert.equal(bySession.total, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buffer is capped at limit (older entries evicted)", () => {
  const { file, dir } = tempFilePath()
  try {
    const store = createFeedbackStore({ filePath: file, limit: 3, logger: silentLogger })
    for (let i = 0; i < 5; i++) {
      store.push({ id: `id-${i}`, at: new Date().toISOString(), traceId: `t-${i}`, session: "s1", rating: "up" })
    }
    const listed = store.list({})
    assert.equal(listed.total, 3)
    assert.deepEqual(listed.rows.map((r) => r.id), ["id-2", "id-3", "id-4"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
