#!/usr/bin/env tsx
/**
 * CLI tool to review a dogfooding session.
 *
 * Usage:
 *   npx tsx apps/orchestrator/src/scripts/review-session.ts [session-key]
 *   npx tsx apps/orchestrator/src/scripts/review-session.ts --list
 *
 * Requires the orchestrator to be running on localhost:4200 (or ORCHESTRATOR_URL).
 */

const orchestratorUrl = (process.env.ORCHESTRATOR_URL ?? "http://localhost:4200").replace(/\/+$/, "")
const sessionArg = process.argv[2]

async function listSessions() {
  const res = await fetch(`${orchestratorUrl}/telemetry/chat?limit=1000&phase=result`)
  if (!res.ok) { console.error(`Failed to fetch telemetry: ${res.status}`); process.exit(1) }
  const data = await res.json() as { rows: Array<{ session: string; at: string; outcome?: string }> }
  const sessions = new Map<string, { count: number; lastAt: string; outcomes: Record<string, number> }>()
  for (const row of data.rows) {
    const s = sessions.get(row.session) ?? { count: 0, lastAt: row.at, outcomes: {} }
    s.count++
    if (row.at > s.lastAt) s.lastAt = row.at
    if (row.outcome) s.outcomes[row.outcome] = (s.outcomes[row.outcome] ?? 0) + 1
    sessions.set(row.session, s)
  }
  console.log("\n  Sessions:\n")
  console.log("  %-30s %6s %6s %6s  %s", "SESSION", "TURNS", "OK", "FAIL", "LAST ACTIVITY")
  console.log("  " + "-".repeat(80))
  for (const [name, info] of [...sessions.entries()].sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt))) {
    const ok = info.outcomes.applied ?? 0
    const fail = info.count - ok
    console.log("  %-30s %6d %6d %6d  %s", name, info.count, ok, fail, info.lastAt.slice(0, 19))
  }
  console.log()
}

type TimelineEntry = {
  at: string
  traceId: string
  promptExcerpt: string
  outcome?: string
  reasonCategory?: string
  reason?: string
  model?: string
  plannerTier?: string
  totalDurationMs?: number
  estimatedUsd?: number | null
  opCount?: number
  opTypes?: string[]
  feedback: { rating: string; note?: string } | null
}

type SessionReview = {
  session: string
  totalTurns: number
  successCount: number
  failureCount: number
  successRate: number
  totalFeedback: number
  thumbsDownCount: number
  flaggedItems: Array<{ traceId: string; note?: string; at: string }>
  timeline: TimelineEntry[]
}

async function reviewSession(session: string) {
  const res = await fetch(`${orchestratorUrl}/telemetry/chat/session-review?session=${encodeURIComponent(session)}`)
  if (!res.ok) { console.error(`Failed to fetch session review: ${res.status}`); process.exit(1) }
  const data = await res.json() as SessionReview

  console.log(`\n  Session: ${data.session}`)
  console.log(`  Turns: ${data.totalTurns}  |  Success: ${data.successCount}  |  Failures: ${data.failureCount}  |  Rate: ${(data.successRate * 100).toFixed(1)}%`)
  console.log(`  Feedback: ${data.totalFeedback} total  |  Thumbs down: ${data.thumbsDownCount}`)
  console.log()

  if (data.timeline.length === 0) {
    console.log("  No chat turns found for this session.\n")
    return
  }

  console.log("  %-5s %-19s %-9s %-40s %-7s %-8s %s", "#", "TIME", "OUTCOME", "PROMPT", "MS", "COST", "FB")
  console.log("  " + "-".repeat(100))

  for (let i = 0; i < data.timeline.length; i++) {
    const t = data.timeline[i]
    const time = t.at?.slice(11, 19) ?? "?"
    const outcome = (t.outcome ?? "?").slice(0, 9)
    const prompt = (t.promptExcerpt ?? "").slice(0, 40)
    const ms = t.totalDurationMs != null ? String(t.totalDurationMs) : "-"
    const cost = t.estimatedUsd != null ? `$${t.estimatedUsd.toFixed(4)}` : "-"
    const fb = t.feedback ? (t.feedback.rating === "down" ? "BAD" : "ok") : ""
    const color = t.feedback?.rating === "down" ? "\x1b[31m" : t.outcome !== "applied" ? "\x1b[33m" : ""
    const reset = color ? "\x1b[0m" : ""
    console.log(`${color}  %-5d %-19s %-9s %-40s %7s %8s %s${reset}`, i + 1, time, outcome, prompt, ms, cost, fb)
    if (t.feedback?.note) {
      console.log(`${color}        Note: "${t.feedback.note}"${reset}`)
    }
    if (t.outcome !== "applied" && t.reason) {
      console.log(`\x1b[33m        Reason: ${t.reason.slice(0, 80)}\x1b[0m`)
    }
  }

  if (data.flaggedItems.length > 0) {
    console.log(`\n  Flagged items (thumbs down):`)
    for (const item of data.flaggedItems) {
      console.log(`    - ${item.at.slice(0, 19)} [${item.traceId}]${item.note ? `: "${item.note}"` : ""}`)
    }
  }

  const totalCost = data.timeline.reduce((sum, t) => sum + (t.estimatedUsd ?? 0), 0)
  console.log(`\n  Total estimated cost: $${totalCost.toFixed(4)}`)
  console.log()
}

if (!sessionArg || sessionArg === "--help") {
  console.log("\nUsage:")
  console.log("  npx tsx apps/orchestrator/src/scripts/review-session.ts <session-key>")
  console.log("  npx tsx apps/orchestrator/src/scripts/review-session.ts --list")
  console.log()
} else if (sessionArg === "--list") {
  void listSessions()
} else {
  void reviewSession(sessionArg)
}
