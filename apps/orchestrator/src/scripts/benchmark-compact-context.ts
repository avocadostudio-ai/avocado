import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

type TelemetryRow = {
  at?: string
  phase?: string
  outcome?: string
  provider?: string
  plannerSource?: string
  modelKey?: string
  modelUsed?: string
  promptHash?: string
  promptExcerpt?: string
  opCount?: number
  planningDurationMs?: number
  firstPlanningTokenMs?: number
  totalDurationMs?: number
  contextPackBytes?: number
  compactContextEnabled?: boolean
  minimalContextEnabled?: boolean
}

type CohortSummary = {
  count: number
  applied: number
  noEffectiveChange: number
  planReadyForApproval: number
  needsClarification: number
  errorLike: number
  needsClarificationRate: number | null
  errorLikeRate: number | null
  p50PlanningMs: number | null
  p95PlanningMs: number | null
  p50FirstTokenMs: number | null
  p95FirstTokenMs: number | null
  avgContextBytes: number | null
  p50ContextBytes: number | null
}

function parseArgs(argv: string[]) {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i]
    if (!part.startsWith("--")) continue
    const key = part.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      args.set(key, "true")
      continue
    }
    args.set(key, next)
    i += 1
  }
  return args
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  return value
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

function summarize(rows: TelemetryRow[]): CohortSummary {
  const planning = rows
    .map((row) => asNumber(row.planningDurationMs))
    .filter((value): value is number => value !== null)
  const firstToken = rows
    .map((row) => asNumber(row.firstPlanningTokenMs))
    .filter((value): value is number => value !== null)
  const contextBytes = rows
    .map((row) => asNumber(row.contextPackBytes))
    .filter((value): value is number => value !== null)

  return {
    count: rows.length,
    applied: rows.filter((row) => row.outcome === "applied").length,
    noEffectiveChange: rows.filter((row) => row.outcome === "no_effective_change").length,
    planReadyForApproval: rows.filter((row) => row.outcome === "plan_ready_for_approval").length,
    needsClarification: rows.filter((row) => row.outcome === "needs_clarification").length,
    errorLike: rows.filter((row) => {
      const outcome = String(row.outcome ?? "")
      return (
        outcome.includes("failed") ||
        outcome.includes("error") ||
        outcome === "guardrail_failure" ||
        outcome === "planning_exhausted" ||
        outcome === "planning_missing"
      )
    }).length,
    needsClarificationRate:
      rows.length > 0 ? rows.filter((row) => row.outcome === "needs_clarification").length / rows.length : null,
    errorLikeRate:
      rows.length > 0
        ? rows.filter((row) => {
            const outcome = String(row.outcome ?? "")
            return (
              outcome.includes("failed") ||
              outcome.includes("error") ||
              outcome === "guardrail_failure" ||
              outcome === "planning_exhausted" ||
              outcome === "planning_missing"
            )
          }).length / rows.length
        : null,
    p50PlanningMs: percentile(planning, 50),
    p95PlanningMs: percentile(planning, 95),
    p50FirstTokenMs: percentile(firstToken, 50),
    p95FirstTokenMs: percentile(firstToken, 95),
    avgContextBytes: average(contextBytes),
    p50ContextBytes: percentile(contextBytes, 50)
  }
}

function formatMetric(value: number | null, digits = 0) {
  if (value === null) return "-"
  return value.toFixed(digits)
}

function boolLabel(value: boolean) {
  return value ? "compact=ON" : "compact=OFF"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const file = resolve(process.cwd(), args.get("file") ?? "../../.data/chat-telemetry.ndjson")
  const limitRaw = Number.parseInt(args.get("limit") ?? "5000", 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 5000
  const outcomes = (args.get("outcomes") ?? "applied,no_effective_change,plan_ready_for_approval")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const modelContains = (args.get("model") ?? "").trim().toLowerCase()
  const provider = (args.get("provider") ?? "").trim().toLowerCase()
  const onlySingleOp = /^(1|true|yes|on)$/i.test((args.get("single-op-only") ?? "true").trim())
  const asJson = /^(1|true|yes|on)$/i.test((args.get("json") ?? "").trim())

  if (!existsSync(file)) {
    throw new Error(`Telemetry file not found: ${file}`)
  }

  const raw = await readFile(file, "utf8")
  const rows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TelemetryRow
      } catch {
        return null
      }
    })
    .filter((row): row is TelemetryRow => !!row)
    .slice(-limit)

  const filtered = rows.filter((row) => {
    if (row.phase !== "result") return false
    if (!row.outcome || !outcomes.includes(row.outcome)) return false
    if (provider && String(row.plannerSource ?? "").toLowerCase() !== provider) return false
    if (modelContains && !String(row.modelUsed ?? "").toLowerCase().includes(modelContains)) return false
    if (onlySingleOp && row.opCount !== 1) return false
    return true
  })

  const byMode = {
    on: filtered.filter((row) => row.compactContextEnabled === true),
    off: filtered.filter((row) => row.compactContextEnabled !== true)
  }

  const onSummary = summarize(byMode.on)
  const offSummary = summarize(byMode.off)

  const pairByHash = new Map<string, { on: number[]; off: number[] }>()
  for (const row of filtered) {
    if (!row.promptHash || typeof row.planningDurationMs !== "number") continue
    const bucket = pairByHash.get(row.promptHash) ?? { on: [], off: [] }
    if (row.compactContextEnabled === true) bucket.on.push(row.planningDurationMs)
    else bucket.off.push(row.planningDurationMs)
    pairByHash.set(row.promptHash, bucket)
  }

  const pairedDiffs: number[] = []
  for (const pair of pairByHash.values()) {
    const onMedian = percentile(pair.on, 50)
    const offMedian = percentile(pair.off, 50)
    if (onMedian === null || offMedian === null) continue
    pairedDiffs.push(onMedian - offMedian)
  }
  const pairedWinRate =
    pairedDiffs.length === 0
      ? null
      : pairedDiffs.filter((delta) => delta < 0).length / pairedDiffs.length

  const report = {
    file,
    scannedRows: rows.length,
    filteredRows: filtered.length,
    outcomes,
    provider: provider || "any",
    modelContains: modelContains || "any",
    onlySingleOp,
    compactOn: onSummary,
    compactOff: offSummary,
    minimalWithinCompactOn: {
      count: byMode.on.filter((row) => row.minimalContextEnabled === true).length,
      nonMinimalCount: byMode.on.filter((row) => row.minimalContextEnabled !== true).length
    },
    paired: {
      comparablePromptHashes: pairedDiffs.length,
      p50PlanningDeltaMs: percentile(pairedDiffs, 50),
      p95PlanningDeltaMs: percentile(pairedDiffs, 95),
      compactWinRate: pairedWinRate
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`File: ${file}`)
  console.log(`Scanned rows: ${rows.length}`)
  console.log(`Filtered result rows: ${filtered.length}`)
  console.log(`Filter: outcomes=${outcomes.join(",")} provider=${provider || "any"} model=${modelContains || "any"} singleOpOnly=${onlySingleOp}`)
  console.log("")
  console.log(`Cohort ${boolLabel(true)}: count=${onSummary.count}`)
  console.log(`  planning p50/p95: ${formatMetric(onSummary.p50PlanningMs)} / ${formatMetric(onSummary.p95PlanningMs)} ms`)
  console.log(`  first-token p50/p95: ${formatMetric(onSummary.p50FirstTokenMs)} / ${formatMetric(onSummary.p95FirstTokenMs)} ms`)
  console.log(`  context bytes avg/p50: ${formatMetric(onSummary.avgContextBytes, 1)} / ${formatMetric(onSummary.p50ContextBytes)} bytes`)
  console.log(`Cohort ${boolLabel(false)}: count=${offSummary.count}`)
  console.log(`  planning p50/p95: ${formatMetric(offSummary.p50PlanningMs)} / ${formatMetric(offSummary.p95PlanningMs)} ms`)
  console.log(`  first-token p50/p95: ${formatMetric(offSummary.p50FirstTokenMs)} / ${formatMetric(offSummary.p95FirstTokenMs)} ms`)
  console.log(`  context bytes avg/p50: ${formatMetric(offSummary.avgContextBytes, 1)} / ${formatMetric(offSummary.p50ContextBytes)} bytes`)
  console.log("")
  console.log(`Paired by promptHash: ${pairedDiffs.length} comparable hashes`)
  console.log(`  planning delta (ON - OFF) p50/p95: ${formatMetric(percentile(pairedDiffs, 50))} / ${formatMetric(percentile(pairedDiffs, 95))} ms`)
  console.log(`  compact win rate: ${pairedWinRate === null ? "-" : `${(pairedWinRate * 100).toFixed(1)}%`}`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Compact-context benchmark failed: ${message}`)
  process.exit(1)
})
