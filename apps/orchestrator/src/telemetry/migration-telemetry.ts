/**
 * Migration telemetry — persists per-migration run data to JSONL for analysis.
 * Follows the same append-flush pattern as chat-telemetry.ts.
 */

import { appendFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"

export type MigrationTelemetryEntry = {
  timestamp: string
  streamId: string
  status: "success" | "error"
  durationMs: number
  numTurns: number
  toolCallCount: number
  toolsUsed: string[]
  /** Tool call sequence with agent context (main vs subagent) */
  toolDetails?: Array<{ tool: string; agent: "main" | "sub"; durationMs?: number }>
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
  sitesCreated: string[]
  userMessage?: string
  /** Per-model token + cost breakdown from Agent SDK */
  modelBreakdown?: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>
  /** Debug artifact directory for this run */
  debugDir?: string
}

const TELEMETRY_FILE = resolve(homedir(), ".data/telemetry/migration-telemetry.jsonl")
const pendingWrites: MigrationTelemetryEntry[] = []
let flushTimer: NodeJS.Timeout | null = null

async function flushNow() {
  if (pendingWrites.length === 0) return
  const pending = pendingWrites.splice(0, pendingWrites.length)
  const lines = pending.map((item) => JSON.stringify(item)).join("\n")
  await mkdir(dirname(TELEMETRY_FILE), { recursive: true })
  await appendFile(TELEMETRY_FILE, `${lines}\n`, "utf8")
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    void flushNow().catch((err: unknown) => {
      console.error("[migration-telemetry] flush failed:", err instanceof Error ? err.message : String(err))
    })
  }, 150)
  flushTimer.unref() // don't keep the event loop alive for debug telemetry
}

// Flush on shutdown to avoid losing entries from multi-dollar agent runs
process.on("beforeExit", () => { void flushNow().catch(() => {}) })

export function pushMigrationTelemetry(entry: MigrationTelemetryEntry) {
  pendingWrites.push(entry)
  scheduleFlush()

  // Also log a summary line to console
  const { inputTokens: inp, outputTokens: out, cacheReadInputTokens: cacheR, cacheCreationInputTokens: cacheC, totalCostUsd: cost } = entry
  console.log(
    `[migration-telemetry] ${entry.streamId.slice(0, 8)} ${entry.status} | ` +
    `${entry.numTurns} turns, ${entry.toolCallCount} tools | ` +
    `tokens: in=${inp} out=${out} cache_read=${cacheR} cache_create=${cacheC} | ` +
    `cost=$${cost.toFixed(4)} | ${(entry.durationMs / 1000).toFixed(1)}s`
  )
}
