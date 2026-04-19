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
  if (explicit && explicit.length > 0) return explicit
  if (explicit === "") return ":memory:" // empty string = explicit ephemeral
  if (process.env.DEMO_MODE === "1") return ":memory:"
  if (process.env.NODE_ENV === "test") return ":memory:"
  return resolve(process.cwd(), "../../.data/orchestrator.db")
}

export function resolveJsonMigrationTtlDays(): number {
  const raw = Number(process.env.ORCHESTRATOR_JSON_MIGRATION_TTL_DAYS ?? 14)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 14
}

// ---------------------------------------------------------------------------
// Singleton access
// ---------------------------------------------------------------------------
let store: SqliteStore | null = null
let openedFile: string | null = null

export function getStore(): SqliteStore {
  if (!store) {
    const file = resolveDbFile()
    store = new SqliteStore({ file })
    openedFile = file
  }
  return store
}

export function isStoreOpenForFile(file: string): boolean {
  return openedFile === file
}

/** Close & clear the singleton. Intended for tests + graceful shutdown. */
export function resetStore() {
  if (store) {
    try { store.close() } catch { /* ignore */ }
  }
  store = null
  openedFile = null
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
