import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { PageDoc } from "@ai-site-editor/shared"
import { toErrorDetail as _unifiedToErrorDetail } from "../errors.js"

// Eval-candidate capture: a sidecar NDJSON of replay-quality records so real
// chat requests (especially thumbs-downed ones) can be promoted into the
// planner eval dataset without relying on after-the-fact trace reconstruction.
// See `eval_self_improving_system` memory for the flywheel this feeds.

export type EvalCandidate = {
  id: string
  at: string
  session: string
  slug: string
  activeBlockId?: string
  activeEditablePath?: string
  prompt: string
  fixture: PageDoc[]
  outcome?: string
  reasonCategory?: string
  plannerTier?: string
  opTypes?: string[]
  opCount?: number
  provider?: string
  modelKey?: string
  modelUsed?: string
}

export type EvalCandidateOpen = Omit<EvalCandidate, "at" | "outcome" | "reasonCategory" | "plannerTier" | "opTypes" | "opCount">
export type EvalCandidateFinalize = Partial<Pick<EvalCandidate, "outcome" | "reasonCategory" | "plannerTier" | "opTypes" | "opCount">>

type Logger = {
  info: (payload: Record<string, unknown>, message?: string) => void
  error: (payload: Record<string, unknown>, message?: string) => void
}

type CreateEvalCandidateStoreArgs = {
  filePath: string
  limit: number
  persistEnabled: boolean
  ttlDays: number
  logger: Logger
}

const toErrorDetail = _unifiedToErrorDetail

export function createEvalCandidateStore(args: CreateEvalCandidateStoreArgs) {
  const open = new Map<string, EvalCandidateOpen>()
  const finalized: EvalCandidate[] = []
  const pendingWrites: EvalCandidate[] = []
  let flushTimer: NodeJS.Timeout | null = null

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
        args.logger.error({ err: toErrorDetail(error), file: args.filePath }, "Failed to flush eval candidates")
      })
    }, 150)
  }

  function isWithinTtl(isoAt: string, now: number, ttlMs: number) {
    const t = Date.parse(isoAt)
    if (!Number.isFinite(t)) return false
    return now - t <= ttlMs
  }

  async function loadFromDisk() {
    if (!args.persistEnabled) return
    if (!existsSync(args.filePath)) return
    try {
      const raw = await readFile(args.filePath, "utf8")
      const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
      const now = Date.now()
      const ttlMs = args.ttlDays * 24 * 60 * 60 * 1000
      finalized.length = 0
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as EvalCandidate
          if (!parsed || typeof parsed !== "object") continue
          if (typeof parsed.id !== "string" || typeof parsed.prompt !== "string") continue
          if (!isWithinTtl(parsed.at, now, ttlMs)) continue
          finalized.push(parsed)
        } catch {
          // ignore malformed lines
        }
      }
      if (finalized.length > args.limit) {
        finalized.splice(0, finalized.length - args.limit)
      }
      args.logger.info({ file: args.filePath, loaded: finalized.length }, "Loaded eval candidates")
    } catch (error) {
      args.logger.error({ err: toErrorDetail(error), file: args.filePath }, "Failed to load eval candidates")
    }
  }

  function start(entry: EvalCandidateOpen) {
    open.set(entry.id, entry)
  }

  function finalize(id: string, patch: EvalCandidateFinalize): EvalCandidate | undefined {
    const opened = open.get(id)
    if (!opened) return undefined
    open.delete(id)
    const record: EvalCandidate = { ...opened, ...patch, at: new Date().toISOString() }
    finalized.push(record)
    if (finalized.length > args.limit) {
      finalized.splice(0, finalized.length - args.limit)
    }
    if (args.persistEnabled) {
      pendingWrites.push(record)
      scheduleFlush()
    }
    args.logger.info(
      {
        event: "eval_candidate",
        id: record.id,
        session: record.session,
        slug: record.slug,
        outcome: record.outcome,
        opTypes: record.opTypes,
        opCount: record.opCount,
        plannerTier: record.plannerTier
      },
      "Eval candidate finalized"
    )
    return record
  }

  function get(id: string): EvalCandidate | undefined {
    for (let i = finalized.length - 1; i >= 0; i--) {
      if (finalized[i]!.id === id) return finalized[i]
    }
    return undefined
  }

  function list(filters: { limit?: number; session?: string; outcome?: string }) {
    const max = Math.min(Math.max(Number(filters.limit) || 100, 1), 1000)
    let rows = finalized
    if (filters.session) rows = rows.filter((r) => r.session === filters.session)
    if (filters.outcome) rows = rows.filter((r) => r.outcome === filters.outcome)
    return { total: rows.length, rows: rows.slice(-max) }
  }

  function cancel(id: string) {
    open.delete(id)
  }

  return { start, finalize, get, list, cancel, loadFromDisk, flushNow }
}

export type EvalCandidateStore = ReturnType<typeof createEvalCandidateStore>
