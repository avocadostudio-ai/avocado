// ---------------------------------------------------------------------------
// Planner quality eval — report generation & regression detection
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { resolve, basename } from "node:path"
import type { CaseScore, EvalReport } from "./eval-types.js"
import { PASS_THRESHOLD, REGRESSION_THRESHOLD } from "./eval-types.js"

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------

type BuildReportInput = {
  scores: CaseScore[]
  totalTimeMs: number
  gitSha: string
  provider: string
  modelKey: string
  modelUsed: string
}

export function buildReport(input: BuildReportInput): EvalReport {
  const { scores, totalTimeMs, gitSha, provider, modelKey, modelUsed } = input

  const passCount = scores.filter((s) => s.pass).length
  const totalCount = scores.length
  const totalCost = scores.reduce((sum, s) => sum + (s.estimatedUsd ?? 0), 0) || null

  // Weighted score — respect per-case weight (default 1.0)
  const weightedScore =
    totalCount > 0
      ? scores.reduce((sum, s) => sum + s.composite, 0) / totalCount
      : 0

  // By category
  const byCategory: Record<string, { score: number; pass: number; total: number }> = {}
  for (const score of scores) {
    const cat = score.category
    if (!byCategory[cat]) byCategory[cat] = { score: 0, pass: 0, total: 0 }
    byCategory[cat].total++
    byCategory[cat].score += score.composite
    if (score.pass) byCategory[cat].pass++
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].score = byCategory[cat].total > 0
      ? byCategory[cat].score / byCategory[cat].total
      : 0
  }

  return {
    timestamp: new Date().toISOString(),
    gitSha,
    provider,
    modelKey,
    modelUsed,
    cases: scores,
    summary: {
      weightedScore,
      passCount,
      totalCount,
      passRate: totalCount > 0 ? passCount / totalCount : 0,
      totalCost,
      totalTimeMs,
      byCategory,
    },
  }
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

export function detectRegressions(
  current: EvalReport,
  baseline: EvalReport
): EvalReport["regressions"] {
  const baseMap = new Map(baseline.cases.map((c) => [c.caseId, c.composite]))
  const regressions: NonNullable<EvalReport["regressions"]> = []

  for (const score of current.cases) {
    const base = baseMap.get(score.caseId)
    if (base === undefined) continue
    const delta = score.composite - base
    if (delta < -REGRESSION_THRESHOLD) {
      regressions.push({
        caseId: score.caseId,
        baselineScore: base,
        currentScore: score.composite,
        delta,
      })
    }
  }

  return regressions.length > 0 ? regressions : undefined
}

// ---------------------------------------------------------------------------
// Load baseline report
// ---------------------------------------------------------------------------

const REPORT_DIR = resolve(process.cwd(), "../../.data/evals/planner")

export async function loadBaseline(
  baselinePath: string,
  provider: string,
  modelKey: string
): Promise<EvalReport | null> {
  if (baselinePath === "latest") {
    return loadLatestBaseline(provider, modelKey)
  }
  const absPath = resolve(process.cwd(), baselinePath)
  if (!existsSync(absPath)) return null
  const raw = await readFile(absPath, "utf-8")
  return JSON.parse(raw) as EvalReport
}

async function loadLatestBaseline(
  provider: string,
  modelKey: string
): Promise<EvalReport | null> {
  if (!existsSync(REPORT_DIR)) return null
  const files = await readdir(REPORT_DIR)
  const prefix = `planner-eval-${provider}-${modelKey}-`
  const matching = files
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse()

  if (matching.length === 0) return null
  const latest = resolve(REPORT_DIR, matching[0])
  const raw = await readFile(latest, "utf-8")
  return JSON.parse(raw) as EvalReport
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------

export async function saveReport(report: EvalReport, outPath?: string): Promise<string> {
  const dir = outPath ? resolve(process.cwd(), outPath, "..") : REPORT_DIR
  await mkdir(dir, { recursive: true })

  const fileName = outPath
    ? basename(outPath)
    : `planner-eval-${report.provider}-${report.modelKey}-${report.gitSha.slice(0, 7)}-${Date.now()}.json`
  const fullPath = outPath ? resolve(process.cwd(), outPath) : resolve(REPORT_DIR, fileName)

  await writeFile(fullPath, JSON.stringify(report, null, 2))
  return fullPath
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

export function printReport(report: EvalReport, quiet: boolean): void {
  const { summary } = report

  // Per-case output is already printed by onCaseComplete during the run.
  // Only print the summary section here.
  console.log("")
  console.log("=".repeat(80))

  // Category breakdown
  const cats = Object.entries(summary.byCategory).sort(([a], [b]) => a.localeCompare(b))
  if (cats.length > 0) {
    console.log("Category breakdown:")
    for (const [cat, data] of cats) {
      console.log(`  ${cat.padEnd(20)} score=${data.score.toFixed(2)}  pass=${data.pass}/${data.total}`)
    }
    console.log("")
  }

  // Summary line
  const costStr = summary.totalCost !== null ? `$${summary.totalCost.toFixed(2)}` : "n/a"
  const timeStr = summary.totalTimeMs > 60_000
    ? `${(summary.totalTimeMs / 1000).toFixed(0)}s`
    : `${summary.totalTimeMs}ms`
  console.log(
    `Summary:  Score=${summary.weightedScore.toFixed(2)}  ` +
    `Pass=${summary.passCount}/${summary.totalCount} (${(summary.passRate * 100).toFixed(0)}%)  ` +
    `Cost=${costStr}  Time=${timeStr}`
  )

  // Regressions
  if (report.regressions && report.regressions.length > 0) {
    console.log("")
    console.log(`\x1b[31mRegressions (${report.regressions.length}):\x1b[0m`)
    for (const reg of report.regressions) {
      console.log(
        `  ${reg.caseId}: ${reg.baselineScore.toFixed(2)} → ${reg.currentScore.toFixed(2)} (${reg.delta > 0 ? "+" : ""}${reg.delta.toFixed(2)})`
      )
    }
  }

  console.log("")
}

// ---------------------------------------------------------------------------
// Exit code decision
// ---------------------------------------------------------------------------

export function computeExitCode(report: EvalReport, minScore: number): number {
  if (report.summary.weightedScore < minScore) return 1
  if (report.regressions && report.regressions.length > 0) return 1
  return 0
}
