#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// eval:promote <traceId>
//
// Reads a captured chat trace from the eval-candidates NDJSON, scaffolds an
// EvalCase with expectedStatus/opTypes/opCount prefilled from the real
// outcome, and writes it to `.data/eval-promoted/<case-id>.json` for human
// review. Category and assertions are left as TODOs — the human edits those
// before merging into eval-dataset.json.
//
// See `eval_candidate_capture` and `eval_self_improving_system` memories.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { EvalCase } from "./eval-types.js"
import type { EvalCandidate } from "../telemetry/eval-candidate-store.js"

export function readCandidates(filePath: string): EvalCandidate[] {
  if (!existsSync(filePath)) return []
  const raw = readFileSync(filePath, "utf8")
  const out: EvalCandidate[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as EvalCandidate
      if (parsed && typeof parsed === "object" && typeof parsed.id === "string" && typeof parsed.prompt === "string") {
        out.push(parsed)
      }
    } catch {
      // skip malformed line
    }
  }
  return out
}

export function scaffoldCaseFromCandidate(candidate: EvalCandidate): EvalCase {
  const promptHash = createHash("sha256").update(candidate.prompt).digest("hex").slice(0, 10)
  const expectedStatus: EvalCase["expectedStatus"] =
    candidate.outcome === "applied" ? "applied" : "needs_clarification"
  const expectedOpTypes = Array.isArray(candidate.opTypes) ? [...new Set(candidate.opTypes)] : []
  const expectedOpCount =
    typeof candidate.opCount === "number" && candidate.opCount > 0
      ? { min: candidate.opCount, max: candidate.opCount }
      : undefined

  const scaffold: EvalCase = {
    id: `promoted-${promptHash}`,
    category: "TODO",
    slug: candidate.slug,
    message: candidate.prompt,
    tags: ["promoted"],
    fixture: candidate.fixture,
    expectedStatus,
    expectedOpTypes,
    assertions: [],
  }
  if (expectedOpCount) scaffold.expectedOpCount = expectedOpCount
  if (candidate.activeBlockId) scaffold.activeBlockId = candidate.activeBlockId
  if (candidate.activeEditablePath) scaffold.activeEditablePath = candidate.activeEditablePath
  return scaffold
}

function defaultCandidatesFile(): string {
  return process.env.EVAL_CANDIDATES_FILE ?? resolve(process.cwd(), "../../.data/eval-candidates.ndjson")
}

function defaultOutDir(): string {
  return process.env.EVAL_PROMOTED_DIR ?? resolve(process.cwd(), "../../.data/eval-promoted")
}

async function main(): Promise<void> {
  const traceId = process.argv[2]
  if (!traceId) {
    console.error("usage: eval:promote <traceId>")
    console.error("       EVAL_CANDIDATES_FILE overrides the source NDJSON")
    console.error("       EVAL_PROMOTED_DIR overrides the output directory")
    process.exit(2)
  }

  const candidatesFile = defaultCandidatesFile()
  const candidates = readCandidates(candidatesFile)
  if (candidates.length === 0) {
    console.error(`No candidates found in ${candidatesFile}.`)
    console.error("Is EVAL_CANDIDATES_ENABLED=1 set on the running orchestrator?")
    process.exit(1)
  }

  const matches = candidates.filter((c) => c.id === traceId)
  const found = matches[matches.length - 1]
  if (!found) {
    console.error(`No candidate with traceId=${traceId} in ${candidatesFile}.`)
    console.error(`Available: ${candidates.slice(-5).map((c) => c.id).join(", ")}`)
    process.exit(1)
  }

  const scaffold = scaffoldCaseFromCandidate(found)
  const outDir = defaultOutDir()
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, `${scaffold.id}.json`)
  writeFileSync(outPath, `${JSON.stringify(scaffold, null, 2)}\n`, "utf8")

  const rel = outPath.replace(`${process.cwd()}/`, "")
  console.log(`Scaffolded ${scaffold.id} from trace ${found.id}`)
  console.log(`  wrote ${rel}`)
  console.log("")
  console.log("Next steps:")
  console.log(`  1. Edit ${rel} — fill in "category", refine tags, add assertions`)
  console.log(`  2. Move it into apps/orchestrator/src/eval/eval-dataset.json (append to the array)`)
  console.log(`  3. Run: pnpm --filter @ai-site-editor/orchestrator eval -- --case ${scaffold.id}`)
}

// Run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
