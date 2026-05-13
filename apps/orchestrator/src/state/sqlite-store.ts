import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import Database from "better-sqlite3"
import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3"
import type { PageDoc, Operation, SiteConfig } from "@avocadostudio-ai/shared"

// ---------------------------------------------------------------------------
// Caps (mirrors limits used by in-memory state)
// ---------------------------------------------------------------------------
export const HISTORY_DEPTH_CAP = 50
export const VERSION_LOG_CAP = 100
export const RECENT_EDITS_CAP = 10
export const CHAT_HISTORY_CAP = 6

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
export type PageKind = "draft" | "published"
export type HistoryDirection = "undo" | "redo"

export type RecentEditEntry = {
  slug: string
  summary: string
  ops: Operation[]
  at: string
}

export type VersionLogEntry = {
  version: number
  slug: string
  summary: string
  opTypes: string[]
  opCount: number
  at: string
  source: "chat" | "direct" | "undo" | "redo" | "bootstrap" | "restore"
  snapshot?: PageDoc | null
}

export type ChatMessage = { role: "user" | "assistant"; content: string }

export type IssueTouchedRow = { slugs: string[]; updatedAt: string }

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  session TEXT NOT NULL,
  slug    TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('draft','published')),
  doc     TEXT NOT NULL,
  PRIMARY KEY (session, slug, kind)
);

CREATE TABLE IF NOT EXISTS history (
  session   TEXT NOT NULL,
  slug      TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('undo','redo')),
  seq       INTEGER NOT NULL,
  snapshot  TEXT,
  PRIMARY KEY (session, slug, direction, seq)
);

CREATE TABLE IF NOT EXISTS version_log (
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  entry   TEXT NOT NULL,
  PRIMARY KEY (session, seq)
);

CREATE TABLE IF NOT EXISTS recent_edits (
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  entry   TEXT NOT NULL,
  PRIMARY KEY (session, seq)
);

CREATE TABLE IF NOT EXISTS chat_history (
  session TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  role    TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  PRIMARY KEY (session, seq)
);

CREATE TABLE IF NOT EXISTS site_configs (
  session TEXT PRIMARY KEY,
  config  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_touched (
  issue_key  TEXT PRIMARY KEY,
  slugs      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

const SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export type SqliteStoreOptions = {
  /** File path. Use ":memory:" for an ephemeral DB. */
  file: string
  /** Disable WAL (e.g. in tests). Defaults to true for file-backed DBs. */
  wal?: boolean
  /** Optional logger for one-shot messages (open/close/migrate). */
  onLog?: (msg: string) => void
}

type Prepared = {
  upsertPage: Statement
  deletePage: Statement
  selectPage: Statement
  listPagesBySessionKind: Statement
  listAllDraftSessions: Statement

  insertHistory: Statement
  popHistoryTop: Statement
  deleteHistoryRow: Statement
  clearHistoryDirection: Statement
  listHistory: Statement
  trimHistory: Statement
  nextHistorySeq: Statement

  upsertSession: Statement
  selectSessionVersion: Statement
  bumpSessionVersion: Statement

  insertVersionLog: Statement
  listVersionLog: Statement
  listVersionLogForSlug: Statement
  trimVersionLog: Statement
  nextVersionLogSeq: Statement

  insertRecentEdit: Statement
  listRecentEdits: Statement
  trimRecentEdits: Statement
  nextRecentEditSeq: Statement

  insertChatMessage: Statement
  listChatHistory: Statement
  trimChatHistory: Statement
  nextChatSeq: Statement

  upsertSiteConfig: Statement
  selectSiteConfig: Statement
  listSiteConfigs: Statement

  upsertIssueTouched: Statement
  selectIssueTouched: Statement
  listIssueTouched: Statement
  trimIssueTouched: Statement
}

export class SqliteStore {
  readonly db: BetterSqliteDatabase
  private readonly stmt: Prepared

  constructor(options: SqliteStoreOptions) {
    const { file } = options
    const useWal = options.wal ?? (file !== ":memory:")

    if (file !== ":memory:") {
      mkdirSync(dirname(resolve(file)), { recursive: true })
    }

    this.db = new Database(file)
    this.db.pragma("foreign_keys = ON")
    if (useWal) {
      this.db.pragma("journal_mode = WAL")
      this.db.pragma("synchronous = NORMAL")
    }

    this.db.exec(SCHEMA)
    this.ensureSchemaVersion()
    this.stmt = this.prepareAll()

    options.onLog?.(`SqliteStore opened: ${file}`)
  }

  private ensureSchemaVersion() {
    const row = this.db
      .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get()
    if (!row) {
      this.db
        .prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION))
    }
  }

  private prepareAll(): Prepared {
    const db = this.db
    return {
      upsertPage: db.prepare(
        `INSERT INTO pages(session, slug, kind, doc) VALUES (?, ?, ?, ?)
         ON CONFLICT(session, slug, kind) DO UPDATE SET doc = excluded.doc`
      ),
      deletePage: db.prepare(
        `DELETE FROM pages WHERE session = ? AND slug = ? AND kind = ?`
      ),
      selectPage: db.prepare(
        `SELECT doc FROM pages WHERE session = ? AND slug = ? AND kind = ?`
      ),
      listPagesBySessionKind: db.prepare(
        `SELECT slug, doc FROM pages WHERE session = ? AND kind = ? ORDER BY slug`
      ),
      listAllDraftSessions: db.prepare(
        `SELECT DISTINCT session FROM pages WHERE kind = 'draft' ORDER BY session`
      ),

      insertHistory: db.prepare(
        `INSERT INTO history(session, slug, direction, seq, snapshot) VALUES (?, ?, ?, ?, ?)`
      ),
      popHistoryTop: db.prepare(
        `SELECT seq, snapshot FROM history
         WHERE session = ? AND slug = ? AND direction = ?
         ORDER BY seq DESC LIMIT 1`
      ),
      deleteHistoryRow: db.prepare(
        `DELETE FROM history WHERE session = ? AND slug = ? AND direction = ? AND seq = ?`
      ),
      clearHistoryDirection: db.prepare(
        `DELETE FROM history WHERE session = ? AND slug = ? AND direction = ?`
      ),
      listHistory: db.prepare(
        `SELECT seq, snapshot FROM history
         WHERE session = ? AND slug = ? AND direction = ?
         ORDER BY seq ASC`
      ),
      trimHistory: db.prepare(
        `DELETE FROM history
         WHERE session = ? AND slug = ? AND direction = ?
           AND seq NOT IN (
             SELECT seq FROM history
             WHERE session = ? AND slug = ? AND direction = ?
             ORDER BY seq DESC LIMIT ?
           )`
      ),
      nextHistorySeq: db.prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM history
         WHERE session = ? AND slug = ? AND direction = ?`
      ),

      upsertSession: db.prepare(
        `INSERT INTO sessions(session, version) VALUES (?, ?)
         ON CONFLICT(session) DO UPDATE SET version = excluded.version`
      ),
      selectSessionVersion: db.prepare(
        `SELECT version FROM sessions WHERE session = ?`
      ),
      bumpSessionVersion: db.prepare(
        `INSERT INTO sessions(session, version) VALUES (?, 1)
         ON CONFLICT(session) DO UPDATE SET version = version + 1
         RETURNING version`
      ),

      insertVersionLog: db.prepare(
        `INSERT INTO version_log(session, seq, entry) VALUES (?, ?, ?)`
      ),
      listVersionLog: db.prepare(
        `SELECT entry FROM version_log WHERE session = ? ORDER BY seq ASC`
      ),
      listVersionLogForSlug: db.prepare(
        `SELECT entry FROM version_log
         WHERE session = ? AND json_extract(entry, '$.slug') = ?
         ORDER BY seq ASC`
      ),
      trimVersionLog: db.prepare(
        `DELETE FROM version_log
         WHERE session = ?
           AND seq NOT IN (
             SELECT seq FROM version_log
             WHERE session = ?
             ORDER BY seq DESC LIMIT ?
           )`
      ),
      nextVersionLogSeq: db.prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM version_log WHERE session = ?`
      ),

      insertRecentEdit: db.prepare(
        `INSERT INTO recent_edits(session, seq, entry) VALUES (?, ?, ?)`
      ),
      listRecentEdits: db.prepare(
        `SELECT entry FROM recent_edits WHERE session = ? ORDER BY seq ASC`
      ),
      trimRecentEdits: db.prepare(
        `DELETE FROM recent_edits
         WHERE session = ?
           AND seq NOT IN (
             SELECT seq FROM recent_edits
             WHERE session = ?
             ORDER BY seq DESC LIMIT ?
           )`
      ),
      nextRecentEditSeq: db.prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM recent_edits WHERE session = ?`
      ),

      insertChatMessage: db.prepare(
        `INSERT INTO chat_history(session, seq, role, content) VALUES (?, ?, ?, ?)`
      ),
      listChatHistory: db.prepare(
        `SELECT role, content FROM chat_history WHERE session = ? ORDER BY seq ASC`
      ),
      trimChatHistory: db.prepare(
        `DELETE FROM chat_history
         WHERE session = ?
           AND seq NOT IN (
             SELECT seq FROM chat_history
             WHERE session = ?
             ORDER BY seq DESC LIMIT ?
           )`
      ),
      nextChatSeq: db.prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM chat_history WHERE session = ?`
      ),

      upsertSiteConfig: db.prepare(
        `INSERT INTO site_configs(session, config) VALUES (?, ?)
         ON CONFLICT(session) DO UPDATE SET config = excluded.config`
      ),
      selectSiteConfig: db.prepare(
        `SELECT config FROM site_configs WHERE session = ?`
      ),
      listSiteConfigs: db.prepare(
        `SELECT session, config FROM site_configs`
      ),

      upsertIssueTouched: db.prepare(
        `INSERT INTO issue_touched(issue_key, slugs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(issue_key) DO UPDATE SET
           slugs = excluded.slugs,
           updated_at = excluded.updated_at`
      ),
      selectIssueTouched: db.prepare(
        `SELECT slugs, updated_at FROM issue_touched WHERE issue_key = ?`
      ),
      listIssueTouched: db.prepare(
        `SELECT issue_key, slugs, updated_at FROM issue_touched ORDER BY updated_at ASC`
      ),
      trimIssueTouched: db.prepare(
        `DELETE FROM issue_touched
         WHERE issue_key NOT IN (
           SELECT issue_key FROM issue_touched
           ORDER BY updated_at DESC LIMIT ?
         )`
      ),
    }
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------
  setPage(session: string, page: PageDoc, kind: PageKind = "draft") {
    this.stmt.upsertPage.run(session, page.slug, kind, JSON.stringify(page))
  }

  getPage(session: string, slug: string, kind: PageKind = "draft"): PageDoc | null {
    const row = this.stmt.selectPage.get(session, slug, kind) as { doc: string } | undefined
    return row ? (JSON.parse(row.doc) as PageDoc) : null
  }

  removePage(session: string, slug: string, kind: PageKind = "draft") {
    this.stmt.deletePage.run(session, slug, kind)
  }

  listPages(session: string, kind: PageKind = "draft"): PageDoc[] {
    const rows = this.stmt.listPagesBySessionKind.all(session, kind) as Array<{ slug: string; doc: string }>
    return rows.map((r) => JSON.parse(r.doc) as PageDoc)
  }

  listDraftSessions(): string[] {
    const rows = this.stmt.listAllDraftSessions.all() as Array<{ session: string }>
    return rows.map((r) => r.session)
  }

  // -------------------------------------------------------------------------
  // History (undo/redo) — capped at HISTORY_DEPTH_CAP per (session,slug,direction)
  // -------------------------------------------------------------------------
  pushHistory(
    session: string,
    slug: string,
    direction: HistoryDirection,
    snapshot: PageDoc | null
  ) {
    const nextRow = this.stmt.nextHistorySeq.get(session, slug, direction) as { next: number }
    const payload = snapshot === null ? null : JSON.stringify(snapshot)
    this.stmt.insertHistory.run(session, slug, direction, nextRow.next, payload)
    this.stmt.trimHistory.run(
      session, slug, direction,
      session, slug, direction, HISTORY_DEPTH_CAP
    )
  }

  popHistory(session: string, slug: string, direction: HistoryDirection): PageDoc | null | undefined {
    const row = this.stmt.popHistoryTop.get(session, slug, direction) as
      | { seq: number; snapshot: string | null }
      | undefined
    if (!row) return undefined
    this.stmt.deleteHistoryRow.run(session, slug, direction, row.seq)
    return row.snapshot === null ? null : (JSON.parse(row.snapshot) as PageDoc)
  }

  clearHistory(session: string, slug: string, direction: HistoryDirection) {
    this.stmt.clearHistoryDirection.run(session, slug, direction)
  }

  listHistory(session: string, slug: string, direction: HistoryDirection): (PageDoc | null)[] {
    const rows = this.stmt.listHistory.all(session, slug, direction) as Array<{
      seq: number
      snapshot: string | null
    }>
    return rows.map((r) => (r.snapshot === null ? null : (JSON.parse(r.snapshot) as PageDoc)))
  }

  // -------------------------------------------------------------------------
  // Version counter
  // -------------------------------------------------------------------------
  getVersion(session: string): number {
    const row = this.stmt.selectSessionVersion.get(session) as { version: number } | undefined
    return row?.version ?? 0
  }

  setVersion(session: string, version: number) {
    this.stmt.upsertSession.run(session, version)
  }

  bumpVersion(session: string): number {
    const row = this.stmt.bumpSessionVersion.get(session) as { version: number }
    return row.version
  }

  // -------------------------------------------------------------------------
  // Version log — capped at VERSION_LOG_CAP per session
  // -------------------------------------------------------------------------
  pushVersionLog(session: string, entry: VersionLogEntry) {
    const next = this.stmt.nextVersionLogSeq.get(session) as { next: number }
    this.stmt.insertVersionLog.run(session, next.next, JSON.stringify(entry))
    this.stmt.trimVersionLog.run(session, session, VERSION_LOG_CAP)
  }

  listVersionLog(session: string, slug?: string, limit = 50): VersionLogEntry[] {
    const rows = (slug
      ? this.stmt.listVersionLogForSlug.all(session, slug)
      : this.stmt.listVersionLog.all(session)) as Array<{ entry: string }>
    const parsed = rows.map((r) => JSON.parse(r.entry) as VersionLogEntry)
    return parsed.slice(-limit)
  }

  // -------------------------------------------------------------------------
  // Recent edits — capped at RECENT_EDITS_CAP per session
  // -------------------------------------------------------------------------
  pushRecentEdit(session: string, entry: RecentEditEntry) {
    const next = this.stmt.nextRecentEditSeq.get(session) as { next: number }
    this.stmt.insertRecentEdit.run(session, next.next, JSON.stringify(entry))
    this.stmt.trimRecentEdits.run(session, session, RECENT_EDITS_CAP)
  }

  listRecentEdits(session: string): RecentEditEntry[] {
    const rows = this.stmt.listRecentEdits.all(session) as Array<{ entry: string }>
    return rows.map((r) => JSON.parse(r.entry) as RecentEditEntry)
  }

  // -------------------------------------------------------------------------
  // Chat history — capped at CHAT_HISTORY_CAP messages per session
  // -------------------------------------------------------------------------
  pushChatMessage(session: string, role: ChatMessage["role"], content: string) {
    const next = this.stmt.nextChatSeq.get(session) as { next: number }
    this.stmt.insertChatMessage.run(session, next.next, role, content)
    this.stmt.trimChatHistory.run(session, session, CHAT_HISTORY_CAP)
  }

  listChatHistory(session: string): ChatMessage[] {
    const rows = this.stmt.listChatHistory.all(session) as Array<ChatMessage>
    return rows.map((r) => ({ role: r.role, content: r.content }))
  }

  // -------------------------------------------------------------------------
  // Site configs
  // -------------------------------------------------------------------------
  setSiteConfig(session: string, config: SiteConfig) {
    this.stmt.upsertSiteConfig.run(session, JSON.stringify(config))
  }

  getSiteConfig(session: string): SiteConfig | null {
    const row = this.stmt.selectSiteConfig.get(session) as { config: string } | undefined
    return row ? (JSON.parse(row.config) as SiteConfig) : null
  }

  listSiteConfigs(): Array<{ session: string; config: SiteConfig }> {
    const rows = this.stmt.listSiteConfigs.all() as Array<{ session: string; config: string }>
    return rows.map((r) => ({ session: r.session, config: JSON.parse(r.config) as SiteConfig }))
  }

  // -------------------------------------------------------------------------
  // Issue-touched slugs
  // -------------------------------------------------------------------------
  setIssueTouched(issueKey: string, row: IssueTouchedRow, cap = 200) {
    this.stmt.upsertIssueTouched.run(issueKey, JSON.stringify(row.slugs), row.updatedAt)
    this.stmt.trimIssueTouched.run(cap)
  }

  getIssueTouched(issueKey: string): IssueTouchedRow | null {
    const row = this.stmt.selectIssueTouched.get(issueKey) as
      | { slugs: string; updated_at: string }
      | undefined
    if (!row) return null
    return { slugs: JSON.parse(row.slugs) as string[], updatedAt: row.updated_at }
  }

  listIssueTouched(): Array<{ issueKey: string; row: IssueTouchedRow }> {
    const rows = this.stmt.listIssueTouched.all() as Array<{
      issue_key: string
      slugs: string
      updated_at: string
    }>
    return rows.map((r) => ({
      issueKey: r.issue_key,
      row: { slugs: JSON.parse(r.slugs) as string[], updatedAt: r.updated_at },
    }))
  }

  // -------------------------------------------------------------------------
  // Transactions — per-request boundary. Nested calls reuse the outer txn.
  // -------------------------------------------------------------------------
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close() {
    this.db.close()
  }
}
