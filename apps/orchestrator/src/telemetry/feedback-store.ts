import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

export type FeedbackRating = "up" | "down"

export type FeedbackEntry = {
  id: string
  at: string
  traceId: string
  session: string
  rating: FeedbackRating
  note?: string
}

type Logger = {
  info: (payload: Record<string, unknown>, message?: string) => void
  error: (payload: Record<string, unknown>, message?: string) => void
}

type CreateFeedbackStoreArgs = {
  filePath: string
  limit: number
  logger: Logger
}

export function createFeedbackStore(args: CreateFeedbackStoreArgs) {
  const buffer: FeedbackEntry[] = []
  const pendingWrites: FeedbackEntry[] = []
  let flushTimer: NodeJS.Timeout | null = null

  async function flushNow() {
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
        args.logger.error({ err: String(error), file: args.filePath }, "Failed to flush feedback")
      })
    }, 150)
  }

  async function loadFromDisk() {
    if (!existsSync(args.filePath)) return
    try {
      const raw = await readFile(args.filePath, "utf8")
      const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
      const tail = lines.slice(-args.limit)
      buffer.length = 0
      for (const line of tail) {
        try {
          const parsed = JSON.parse(line) as FeedbackEntry
          if (!parsed || typeof parsed !== "object") continue
          if (typeof parsed.id !== "string" || typeof parsed.rating !== "string") continue
          buffer.push(parsed)
        } catch {
          // Ignore malformed lines.
        }
      }
      args.logger.info({ file: args.filePath, loaded: buffer.length }, "Loaded feedback entries")
    } catch (error) {
      args.logger.error({ err: String(error), file: args.filePath }, "Failed to load feedback")
    }
  }

  function push(entry: FeedbackEntry) {
    buffer.push(entry)
    if (buffer.length > args.limit) {
      buffer.splice(0, buffer.length - args.limit)
    }
    pendingWrites.push(entry)
    scheduleFlush()
    args.logger.info(
      { event: "feedback", id: entry.id, traceId: entry.traceId, session: entry.session, rating: entry.rating },
      "Feedback recorded"
    )
  }

  function list(filters: { session?: string; rating?: string; traceId?: string; limit?: number }) {
    const max = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000)
    let rows = buffer
    if (filters.session) rows = rows.filter((r) => r.session === filters.session)
    if (filters.rating) rows = rows.filter((r) => r.rating === filters.rating)
    if (filters.traceId) rows = rows.filter((r) => r.traceId === filters.traceId)
    return {
      total: rows.length,
      rows: rows.slice(-max)
    }
  }

  return { push, list, loadFromDisk, flushNow }
}

export type FeedbackStore = ReturnType<typeof createFeedbackStore>
