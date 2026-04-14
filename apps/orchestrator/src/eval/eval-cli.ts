// ---------------------------------------------------------------------------
// Planner quality eval — CLI entry point
// Usage: NODE_ENV=test tsx src/eval/eval-cli.ts [flags]
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { AIProvider, ModelKey } from "../state/session-state.js"
import type { EvalCase } from "./eval-types.js"
import { PASS_THRESHOLD } from "./eval-types.js"
import { runEval } from "./eval-runner.js"
import {
  buildReport,
  detectRegressions,
  loadBaseline,
  saveReport,
  printReport,
  computeExitCode,
} from "./eval-report.js"

// ---------------------------------------------------------------------------
// Arg parsing (same pattern as benchmark-models.ts)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (!item.startsWith("--")) continue
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      args.set(key, "true")
      continue
    }
    args.set(key, next)
    i++
  }
  return args
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}

function resolveProvider(): AIProvider {
  const raw = (process.env.E2E_CHAT_PROVIDER ?? process.env.EVAL_PROVIDER ?? "openai").trim().toLowerCase()
  if (raw === "anthropic") return "anthropic"
  if (raw === "gemini") return "gemini"
  return "openai"
}

function matchesGlob(id: string, pattern: string): boolean {
  if (!pattern.includes("*")) return id === pattern
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$")
  return regex.test(id)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const provider = (args.get("provider") ?? resolveProvider()) as AIProvider
  const modelKey = (args.get("model-key") ?? process.env.E2E_CHAT_MODEL_KEY ?? "balanced") as ModelKey
  const concurrency = Math.max(1, parseInt(args.get("concurrency") ?? "5", 10) || 5)
  const minScore = parseFloat(args.get("min-score") ?? String(PASS_THRESHOLD)) || PASS_THRESHOLD
  const baselinePath = args.get("baseline")
  const outPath = args.get("out")
  const quiet = args.has("quiet")
  const tagsFilter = args.get("tags")?.split(",").map((t) => t.trim()).filter(Boolean)
  const casesFilter = args.get("cases")?.split(",").map((c) => c.trim()).filter(Boolean)

  // Load dataset
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const datasetPath = resolve(__dirname, "eval-dataset.json")
  const allCases = JSON.parse(readFileSync(datasetPath, "utf-8")) as EvalCase[]

  // Filter cases
  let cases = allCases
  if (tagsFilter && tagsFilter.length > 0) {
    cases = cases.filter((c) => c.tags.some((t) => tagsFilter.includes(t)))
  }
  if (casesFilter && casesFilter.length > 0) {
    cases = cases.filter((c) => casesFilter.some((pattern) => matchesGlob(c.id, pattern)))
  }

  if (cases.length === 0) {
    console.error("No eval cases matched the given filters.")
    process.exit(1)
  }

  console.log(`Planner Eval — ${provider}/${modelKey} — ${cases.length} cases (concurrency=${concurrency})`)
  console.log("")

  // Run
  const { scores, totalTimeMs } = await runEval({
    provider,
    modelKey,
    concurrency,
    cases,
    quiet,
    onCaseComplete: (score, index, total) => {
      if (!quiet) {
        const tag = score.pass ? "\x1b[32m[PASS]\x1b[0m" : "\x1b[31m[FAIL]\x1b[0m"
        const cost = score.estimatedUsd !== null ? `$${score.estimatedUsd.toFixed(3)}` : "n/a"
        console.log(`${tag} ${score.caseId.padEnd(45)} ${score.composite.toFixed(2)}  (${score.latencyMs}ms, ${cost})`)
        if (score.failureDetails && score.failureDetails.length > 0) {
          for (const detail of score.failureDetails.slice(0, 2)) {
            console.log(`  \x1b[33m↳ ${detail}\x1b[0m`)
          }
        }
      }
    },
  })

  // Build report
  const gitSha = getGitSha()
  const report = buildReport({
    scores,
    totalTimeMs,
    gitSha,
    provider,
    modelKey,
    modelUsed: `${provider}/${modelKey}`,
  })

  // Load baseline and detect regressions
  if (baselinePath) {
    const baseline = await loadBaseline(baselinePath, provider, modelKey)
    if (baseline) {
      report.regressions = detectRegressions(report, baseline)
      console.log(`\nBaseline: ${baseline.timestamp} (score=${baseline.summary.weightedScore.toFixed(2)})`)
      const delta = report.summary.weightedScore - baseline.summary.weightedScore
      console.log(`vs baseline: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`)
    } else {
      console.log("\nNo baseline found — skipping regression check.")
    }
  }

  // Print summary
  printReport(report, quiet)

  // Save report
  const savedPath = await saveReport(report, outPath)
  console.log(`Report saved: ${savedPath}`)

  // Exit code
  const exitCode = computeExitCode(report, minScore)
  if (exitCode !== 0) {
    if (report.summary.weightedScore < minScore) {
      console.log(`\x1b[31mFAIL: score ${report.summary.weightedScore.toFixed(2)} < min ${minScore.toFixed(2)}\x1b[0m`)
    }
    if (report.regressions && report.regressions.length > 0) {
      console.log(`\x1b[31mFAIL: ${report.regressions.length} regression(s) detected\x1b[0m`)
    }
  }

  process.exit(exitCode)
}

main().catch((err) => {
  console.error("Eval failed:", err)
  process.exit(2)
})
