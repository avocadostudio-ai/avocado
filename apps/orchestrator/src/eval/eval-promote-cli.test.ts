import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PageDoc } from "@avocadostudio-ai/shared"
import type { EvalCandidate } from "../telemetry/eval-candidate-store.js"
import { readCandidates, scaffoldCaseFromCandidate } from "./eval-promote-cli.js"

const samplePages: PageDoc[] = [
  { id: "p_home", slug: "/", title: "Home", updatedAt: "2026-03-03T00:00:00.000Z", blocks: [{ id: "b_hero", type: "Hero", props: { heading: "Hi" } }] }
]

function makeCandidate(overrides: Partial<EvalCandidate> = {}): EvalCandidate {
  return {
    id: "trace-abc",
    at: "2026-04-18T12:00:00.000Z",
    session: "s1",
    slug: "/",
    prompt: "make the hero bolder",
    fixture: samplePages,
    outcome: "applied",
    opTypes: ["update_props"],
    opCount: 1,
    plannerTier: "full_llm",
    ...overrides,
  }
}

test("scaffoldCaseFromCandidate fills expectedStatus from applied outcome", () => {
  const scaffold = scaffoldCaseFromCandidate(makeCandidate())
  assert.equal(scaffold.expectedStatus, "applied")
  assert.deepEqual(scaffold.expectedOpTypes, ["update_props"])
  assert.deepEqual(scaffold.expectedOpCount, { min: 1, max: 1 })
  assert.equal(scaffold.slug, "/")
  assert.equal(scaffold.message, "make the hero bolder")
  assert.equal(scaffold.category, "TODO")
  assert.deepEqual(scaffold.tags, ["promoted"])
  assert.deepEqual(scaffold.assertions, [])
  assert.equal(scaffold.fixture, samplePages)
})

test("scaffoldCaseFromCandidate marks needs_clarification when outcome is not applied", () => {
  const scaffold = scaffoldCaseFromCandidate(makeCandidate({ outcome: "needs_clarification", opTypes: [], opCount: 0 }))
  assert.equal(scaffold.expectedStatus, "needs_clarification")
  assert.deepEqual(scaffold.expectedOpTypes, [])
  assert.equal(scaffold.expectedOpCount, undefined)
})

test("scaffoldCaseFromCandidate propagates activeBlockId and activeEditablePath", () => {
  const scaffold = scaffoldCaseFromCandidate(
    makeCandidate({ activeBlockId: "b_hero", activeEditablePath: "heading" })
  )
  assert.equal(scaffold.activeBlockId, "b_hero")
  assert.equal(scaffold.activeEditablePath, "heading")
})

test("scaffoldCaseFromCandidate derives deterministic id from the prompt", () => {
  const a = scaffoldCaseFromCandidate(makeCandidate({ id: "trace-1" }))
  const b = scaffoldCaseFromCandidate(makeCandidate({ id: "trace-2" }))
  assert.equal(a.id, b.id, "same prompt → same scaffold id regardless of traceId")
  assert.ok(a.id.startsWith("promoted-"))

  const different = scaffoldCaseFromCandidate(makeCandidate({ prompt: "different prompt entirely" }))
  assert.notEqual(a.id, different.id, "different prompt → different scaffold id")
})

test("scaffoldCaseFromCandidate deduplicates repeated opTypes", () => {
  const scaffold = scaffoldCaseFromCandidate(makeCandidate({ opTypes: ["update_props", "update_props", "add_block"] }))
  assert.deepEqual(scaffold.expectedOpTypes, ["update_props", "add_block"])
})

test("readCandidates parses NDJSON and skips malformed lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-promote-"))
  const file = join(dir, "candidates.ndjson")
  try {
    const lines = [
      JSON.stringify(makeCandidate({ id: "good-1" })),
      "{ not valid json",
      "",
      JSON.stringify({ id: "not-a-candidate" }), // missing prompt field
      JSON.stringify(makeCandidate({ id: "good-2", prompt: "second prompt" })),
    ]
    writeFileSync(file, lines.join("\n"), "utf8")

    const parsed = readCandidates(file)
    assert.equal(parsed.length, 2)
    assert.deepEqual(parsed.map((c) => c.id), ["good-1", "good-2"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readCandidates returns [] for missing file", () => {
  const parsed = readCandidates("/tmp/definitely-does-not-exist-xyz.ndjson")
  assert.deepEqual(parsed, [])
})
