import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export type ChatTelemetryPhase =
  | "received"
  | "forced_plan"
  | "plan_attempt_failed"
  | "plan_generated"
  | "plan_apply_failed"
  | "repair_attempt"
  | "repair_generated"
  | "result"

export type ChatTelemetryEntry = {
  id: string
  at: string
  phase: ChatTelemetryPhase
  session: string
  requestedSlug: string
  effectiveSlug: string
  plannerSource: "openai" | "anthropic" | "demo"
  modelKey: string
  modelUsed: string
  promptHash: string
  promptExcerpt: string
  promptLength: number
  outcome?: string
  reason?: string
  reasonCategory?: string
  opCount?: number
  opTypes?: string[]
  intent?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  estimatedUsd?: number | null
}

type Logger = {
  info: (payload: Record<string, unknown>, message?: string) => void
  error: (payload: Record<string, unknown>, message?: string) => void
}

type CreateChatTelemetryStoreArgs = {
  filePath: string
  limit: number
  persistEnabled: boolean
  logger: Logger
}

function toErrorDetail(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createChatTelemetryStore(args: CreateChatTelemetryStoreArgs) {
  const buffer: ChatTelemetryEntry[] = []
  const pendingWrites: ChatTelemetryEntry[] = []
  let flushTimer: NodeJS.Timeout | null = null

  function promptExcerpt(message: string) {
    return message.replace(/\s+/g, " ").trim().slice(0, 180)
  }

  function promptHash(message: string) {
    return createHash("sha256").update(message).digest("hex").slice(0, 16)
  }

  async function flushNow() {
    if (!args.persistEnabled) return
    if (pendingWrites.length === 0) return
    const pending = pendingWrites.splice(0, pendingWrites.length)
    const lines = pending.map((item) => JSON.stringify(item)).join("\n")
    await mkdir(resolve(args.filePath, ".."), { recursive: true })
    await appendFile(args.filePath, `${lines}\n`, "utf8")
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      void flushNow().catch((error: unknown) => {
        args.logger.error({ err: toErrorDetail(error), file: args.filePath }, "Failed to flush chat telemetry")
      })
    }, 150)
  }

  async function loadFromDisk() {
    if (!args.persistEnabled) return
    if (!existsSync(args.filePath)) return
    try {
      const raw = await readFile(args.filePath, "utf8")
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
      const tail = lines.slice(-Math.max(args.limit, 100))
      buffer.length = 0
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as ChatTelemetryEntry
          if (!parsed || typeof parsed !== "object") continue
          if (typeof parsed.id !== "string" || typeof parsed.phase !== "string") continue
          buffer.push(parsed)
        } catch {
          // Ignore malformed telemetry lines.
        }
      }
      args.logger.info({ file: args.filePath, loaded: buffer.length }, "Loaded chat telemetry")
    } catch (error) {
      args.logger.error({ err: toErrorDetail(error), file: args.filePath }, "Failed to load chat telemetry")
    }
  }

  function push(entry: ChatTelemetryEntry) {
    buffer.push(entry)
    if (buffer.length > args.limit) {
      buffer.splice(0, buffer.length - args.limit)
    }
    if (args.persistEnabled) {
      pendingWrites.push(entry)
      scheduleFlush()
    }
    args.logger.info(
      {
        event: "chat_telemetry",
        id: entry.id,
        phase: entry.phase,
        session: entry.session,
        requestedSlug: entry.requestedSlug,
        effectiveSlug: entry.effectiveSlug,
        plannerSource: entry.plannerSource,
        modelKey: entry.modelKey,
        modelUsed: entry.modelUsed,
        promptHash: entry.promptHash,
        promptLength: entry.promptLength,
        outcome: entry.outcome,
        reasonCategory: entry.reasonCategory,
        opCount: entry.opCount,
        opTypes: entry.opTypes,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        estimatedUsd: entry.estimatedUsd
      },
      "Chat telemetry event"
    )
  }

  function list(args: { limit?: number; outcome?: string; phase?: string; session?: string }) {
    const limitRaw = Number(args.limit ?? 100)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 1000) : 100
    let rows = buffer
    if (args.outcome) rows = rows.filter((row) => row.outcome === args.outcome)
    if (args.phase) rows = rows.filter((row) => row.phase === args.phase)
    if (args.session) rows = rows.filter((row) => row.session === args.session)

    const recent = rows.slice(Math.max(0, rows.length - limit))
    const byOutcome: Record<string, number> = {}
    const byReasonCategory: Record<string, number> = {}
    for (const row of recent) {
      if (row.outcome) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1
      if (row.reasonCategory) byReasonCategory[row.reasonCategory] = (byReasonCategory[row.reasonCategory] ?? 0) + 1
    }
    return {
      totalBuffered: buffer.length,
      returned: recent.length,
      byOutcome,
      byReasonCategory,
      rows: recent
    }
  }

  function review(args: { limit?: number; session?: string }) {
    const limitRaw = Number(args.limit ?? 300)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 2000) : 300
    let rows = buffer
    if (args.session) rows = rows.filter((row) => row.session === args.session)
    const recent = rows.slice(Math.max(0, rows.length - limit))

    const failureOutcomes = new Set([
      "guardrail_failure",
      "apply_failed",
      "repair_failed",
      "planner_exception",
      "planning_exhausted",
      "planning_missing"
    ])
    const failures = recent.filter((row) => row.phase === "result" && row.outcome && failureOutcomes.has(row.outcome))
    const success = recent.filter((row) => row.phase === "result" && row.outcome === "applied")

    const failureByReasonCategory: Record<string, number> = {}
    const failureByOutcome: Record<string, number> = {}
    const byPromptHash = new Map<
      string,
      { promptExcerpt: string; count: number; outcomes: Record<string, number>; reasonCategories: Record<string, number>; lastAt: string }
    >()

    for (const row of failures) {
      if (row.reasonCategory) failureByReasonCategory[row.reasonCategory] = (failureByReasonCategory[row.reasonCategory] ?? 0) + 1
      if (row.outcome) failureByOutcome[row.outcome] = (failureByOutcome[row.outcome] ?? 0) + 1
      const current =
        byPromptHash.get(row.promptHash) ??
        { promptExcerpt: row.promptExcerpt, count: 0, outcomes: {}, reasonCategories: {}, lastAt: row.at }
      current.count += 1
      if (row.outcome) current.outcomes[row.outcome] = (current.outcomes[row.outcome] ?? 0) + 1
      if (row.reasonCategory) current.reasonCategories[row.reasonCategory] = (current.reasonCategories[row.reasonCategory] ?? 0) + 1
      if (row.at > current.lastAt) current.lastAt = row.at
      byPromptHash.set(row.promptHash, current)
    }

    const topFailedPrompts = Array.from(byPromptHash.entries())
      .map(([promptHash, value]) => ({ promptHash, ...value }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12)

    const recommendations: string[] = []
    if ((failureByReasonCategory.schema_violation ?? 0) > 0) {
      recommendations.push("Schema violations are frequent: add stricter pre-apply normalization for missing required fields and alias keys.")
    }
    if ((failureByReasonCategory.not_found ?? 0) > 0) {
      recommendations.push("Not-found failures detected: improve slug/block resolution using active selection and current page context.")
    }
    if ((failureByReasonCategory.ambiguity ?? 0) > 0) {
      recommendations.push("Ambiguity is high: improve follow-up question templates with explicit selectable options.")
    }
    if ((failureByOutcome.planning_exhausted ?? 0) > 0) {
      recommendations.push("Planner retries are exhausting: add deterministic fallback plans for the top failed prompt families.")
    }
    if (recommendations.length === 0) {
      recommendations.push("No dominant failure mode detected in this sample. Review top failed prompts and add targeted tests for each.")
    }

    return {
      analyzed: recent.length,
      appliedCount: success.length,
      failedCount: failures.length,
      failureRate: recent.length > 0 ? Number((failures.length / recent.length).toFixed(4)) : 0,
      failureByOutcome,
      failureByReasonCategory,
      topFailedPrompts,
      recommendations
    }
  }

  return {
    promptExcerpt,
    promptHash,
    push,
    loadFromDisk,
    list,
    review
  }
}

export type ChatTelemetryStore = ReturnType<typeof createChatTelemetryStore>
