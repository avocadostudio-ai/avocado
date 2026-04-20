import { existsSync } from "node:fs"
import { rename, readFile, readdir, stat, unlink } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import type { FastifyBaseLogger } from "fastify"
import { SqliteStore } from "./sqlite-store.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export function resolveDbFile(): string {
  const explicit = process.env.ORCHESTRATOR_DB_FILE
  // Treat unset AND empty-string as "use the default" — matches how users
  // get `.env.example` (which has `ORCHESTRATOR_DB_FILE=` empty). Ephemeral
  // mode is still reachable via DEMO_MODE=1, NODE_ENV=test, or setting the
  // env var to the literal ":memory:".
  if (explicit && explicit.length > 0) return explicit
  if (process.env.DEMO_MODE === "1") return ":memory:"
  if (process.env.NODE_ENV === "test") return ":memory:"
  return resolve(process.cwd(), "../../.data/orchestrator.db")
}

export function resolveJsonMigrationTtlDays(): number {
  const raw = Number(process.env.ORCHESTRATOR_JSON_MIGRATION_TTL_DAYS ?? 14)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 14
}

export function resolveBackupLimit(): number {
  const raw = Number(process.env.ORCHESTRATOR_DB_BACKUP_LIMIT ?? 14)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 14
}

export function resolveBackupIntervalHours(): number {
  const raw = Number(process.env.ORCHESTRATOR_DB_BACKUP_INTERVAL_HOURS ?? 24)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 24
}

// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------
let store: SqliteStore | null = null

export function getStore(): SqliteStore {
  if (!store) {
    store = new SqliteStore({ file: resolveDbFile() })
  }
  return store
}

/** Close & clear the singleton. Intended for tests + graceful shutdown. */
export function resetStore() {
  if (store) {
    try { store.close() } catch { /* ignore */ }
  }
  store = null
}

// ---------------------------------------------------------------------------
// JSON migration helpers
// ---------------------------------------------------------------------------
/**
 * Rename `<path>` to `<path>.migrated-<iso-ts>` so it won't be re-imported.
 * Returns the new path, or null on failure.
 */
export async function archiveMigratedJson(jsonPath: string): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const dest = `${jsonPath}.migrated-${stamp}`
    await rename(jsonPath, dest)
    return dest
  } catch {
    return null
  }
}

/**
 * Delete `.migrated-*` sibling files older than `ttlDays` in the same dir.
 * Silent on failures — cleanup is opportunistic.
 */
export async function sweepStaleMigrations(
  jsonPath: string,
  ttlDays: number,
  logger: FastifyBaseLogger
): Promise<number> {
  if (ttlDays <= 0) return 0
  const dir = dirname(jsonPath)
  const prefix = `${basename(jsonPath)}.migrated-`
  let removed = 0
  try {
    const entries = await readdir(dir)
    const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000
    for (const name of entries) {
      if (!name.startsWith(prefix)) continue
      const full = resolve(dir, name)
      try {
        const st = await stat(full)
        if (st.mtimeMs < cutoff) {
          await unlink(full)
          removed++
          logger.info({ file: full, ttlDays }, "Removed stale migrated state file")
        }
      } catch { /* ignore individual failures */ }
    }
  } catch { /* dir missing — nothing to do */ }
  return removed
}

/**
 * If `jsonPath` exists and is non-empty, read + parse it and return the raw
 * payload. Caller is responsible for applying it into Maps + DB.
 */
export async function readLegacyJson<T>(jsonPath: string): Promise<T | null> {
  if (!existsSync(jsonPath)) return null
  try {
    const raw = await readFile(jsonPath, "utf8")
    if (raw.trim().length === 0) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SQLite binary backups — periodic full-DB copies via `VACUUM INTO` so that
// if the live .db ever corrupts (WAL torn write, bit rot, accidental rm)
// we have a recent known-good snapshot. Uses the same rolling-limit
// discipline the old JSON backup path had.
// ---------------------------------------------------------------------------
/**
 * Run a `VACUUM INTO '<dbPath>.backup-<ts>'` snapshot and rotate off the
 * oldest copies once more than `limit` accumulate. Opens a fresh short-lived
 * connection so the live handle's prepared statements stay untouched.
 * Silent on failures — backups are best-effort.
 */
export async function runSqliteBackup(
  dbPath: string,
  limit: number,
  logger: FastifyBaseLogger
): Promise<string | null> {
  if (dbPath === ":memory:") return null
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = `${dbPath}.backup-${stamp}`
  try {
    // Short-lived connection to the live DB, just to issue VACUUM INTO.
    // better-sqlite3 is loaded lazily by the singleton; import locally to
    // avoid a top-level dependency cycle with SqliteStore.
    const { default: Database } = await import("better-sqlite3")
    const db = new Database(dbPath, { readonly: false })
    try {
      db.prepare(`VACUUM INTO ?`).run(backupPath)
    } finally {
      db.close()
    }
    logger.info({ file: backupPath }, "Wrote orchestrator SQLite backup")
  } catch (err) {
    logger.error({ err, backupPath }, "Failed to write SQLite backup")
    return null
  }

  // Rotate — keep the newest `limit` by filename (ISO-timestamped, so
  // lexical order == chronological order).
  try {
    const dir = dirname(dbPath)
    const prefix = `${basename(dbPath)}.backup-`
    const entries = await readdir(dir)
    const backups = entries.filter((n) => n.startsWith(prefix)).sort()
    if (backups.length > limit) {
      const toDelete = backups.slice(0, backups.length - limit)
      await Promise.all(
        toDelete.map((name) =>
          unlink(resolve(dir, name)).catch(() => { /* ignore */ })
        )
      )
      logger.info({ removed: toDelete.length, kept: limit }, "Rotated old SQLite backups")
    }
  } catch { /* ignore rotation failures */ }

  return backupPath
}
