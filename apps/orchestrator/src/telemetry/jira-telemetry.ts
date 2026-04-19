/**
 * Jira ticket telemetry — persists per-run traces to JSONL so each ticket
 * can be reviewed end-to-end after a test (instruction → tool calls → summary).
 * Follows the append-flush pattern of chat-telemetry.ts / migration-telemetry.ts.
 *
 * Location: ~/.data/telemetry/jira-telemetry.jsonl
 */

import { appendFile, mkdir } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { homedir } from "node:os"

export type JiraToolCallTrace = {
  name: string
  /** Redacted/truncated input — see redactToolInput */
  input: unknown
  durationMs: number
  /** First ~400 chars of the tool's string result, for quick scan */
  resultExcerpt: string
  isError: boolean
}

export type JiraTelemetryEntry = {
  timestamp: string
  issueKey: string
  mode: "review" | "execute" | "publish"
  siteId: string
  session: string
  status: "success" | "error"
  durationMs: number
  model?: string
  provider?: string
  /** Full instruction string sent to the agent (after comment history is appended) */
  instruction?: string
  /** Review-mode only: parsed JSON verdict */
  reviewDecision?: { decision: "proceed" | "questions"; plan: string[]; questions?: string[] }
  /** Execute-mode only: tool-by-tool trace */
  toolCalls?: JiraToolCallTrace[]
  /** Number of `tool_done` events the loop saw (matches pino log totals) */
  toolCallCount?: number
  /** Final summary text the agent returned (execute mode) */
  summary?: string
  /** Changes array (execute mode) — one string per applied op group */
  changes?: string[]
  /** Slugs touched (execute mode) */
  touchedSlugs?: string[]
  /** True when auto-publish or publish mode succeeded */
  published?: boolean
  /** Status transitions attempted during the run */
  transitions?: string[]
  /** Error message (status=error) */
  error?: string
}

const TELEMETRY_FILE = resolve(homedir(), ".data/telemetry/jira-telemetry.jsonl")
const pendingWrites: JiraTelemetryEntry[] = []
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
      console.error("[jira-telemetry] flush failed:", err instanceof Error ? err.message : String(err))
    })
  }, 150)
  flushTimer.unref()
}

process.on("beforeExit", () => { void flushNow().catch(() => {}) })

export function pushJiraTelemetry(entry: JiraTelemetryEntry) {
  pendingWrites.push(entry)
  scheduleFlush()

  // Console summary so tail -f on stdout reads well during live testing.
  const toolPart = entry.toolCalls && entry.toolCalls.length > 0
    ? ` | tools: ${entry.toolCalls.map((t) => t.name).join(",")}`
    : ""
  const decisionPart = entry.reviewDecision ? ` | ${entry.reviewDecision.decision}` : ""
  console.log(
    `[jira-telemetry] ${entry.issueKey} ${entry.mode} ${entry.status} ` +
    `| ${(entry.durationMs / 1000).toFixed(1)}s${decisionPart}${toolPart}` +
    (entry.error ? ` | err: ${entry.error.slice(0, 120)}` : "")
  )
}

/**
 * Make an object safe for JSONL — shallow clone and truncate large string
 * values. Preserves structure so analysis scripts can still inspect shape.
 */
export function redactToolInput(input: unknown, maxStringChars = 1000): unknown {
  if (input == null || typeof input !== "object") return input
  if (Array.isArray(input)) {
    return input.slice(0, 50).map((v) => redactToolInput(v, maxStringChars))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > maxStringChars) {
      out[k] = `${v.slice(0, maxStringChars)}… [truncated ${v.length - maxStringChars} chars]`
    } else if (typeof v === "object" && v !== null) {
      out[k] = redactToolInput(v, maxStringChars)
    } else {
      out[k] = v
    }
  }
  return out
}
