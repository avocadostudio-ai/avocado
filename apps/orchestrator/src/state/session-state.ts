import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { FastifyBaseLogger } from "fastify"
import {
  demoPublishedPages,
  IMAGE_PLACEHOLDER,
  type EditPlan,
  type Operation,
  type PageDoc,
  type SiteConfig
} from "@ai-site-editor/shared"
import { toErrorDetail as _unifiedToErrorDetail } from "../errors.js"
import {
  archiveMigratedJson,
  getStore,
  readLegacyJson,
  resolveJsonMigrationTtlDays,
  sweepStaleMigrations,
} from "./sqlite-store-singleton.js"
import type { SqliteStore } from "./sqlite-store.js"

// ---------------------------------------------------------------------------
// ModelKey inline type (avoids circular dependency with index.ts)
// ---------------------------------------------------------------------------
export type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
export type AIProvider = "openai" | "anthropic" | "gemini"

// ---------------------------------------------------------------------------
// Session-key helpers
// ---------------------------------------------------------------------------
export const DEFAULT_SITE_ID = "avocado-stories"
export const DEFAULT_SESSION = "dev"

export function normalizeSiteId(value: unknown) {
  if (typeof value !== "string") return DEFAULT_SITE_ID
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || DEFAULT_SITE_ID
}

export function normalizeSession(value: unknown) {
  if (typeof value !== "string") return DEFAULT_SESSION
  const cleaned = value.trim()
  return cleaned || DEFAULT_SESSION
}

/** Returns true for the default JSON-file site (avocado-stories). */
export function isLegacySiteId(siteId: string) {
  return siteId === DEFAULT_SITE_ID || siteId === "default"
}

export function scopedSessionKey(session: unknown, siteId: unknown) {
  const normalizedSession = normalizeSession(session)
  const normalizedSiteId = normalizeSiteId(siteId)
  if (isLegacySiteId(normalizedSiteId)) {
    return normalizedSession
  }
  return `${normalizedSiteId}::${normalizedSession}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type PendingImageGeneration = {
  blockId: string
  pageSlug: string
  path?: string
  altPath?: string
  query: string
  provider: "openai" | "unsplash" | "gdrive" | "auto"
}

export type PendingApprovalPlan = {
  id: string
  createdAt: string
  promptHash: string
  requestedSlug: string
  effectiveSlug: string
  summary: string
  source: "openai" | "anthropic" | "gemini" | "demo"
  modelUsed: string
  modelKey: ModelKey
  plan: EditPlan
  pendingImageOps?: PendingImageGeneration[]
  originalMessage?: string
}

export type ContinuationChain = {
  id: string
  steps: string[]
  stepLabels: string[]
  currentStep: number
  totalSteps: number
  originalMessage: string
  effectiveSlug: string
  siteContextBlock: string | null
}

export const continuationChainBySession = new Map<string, ContinuationChain>()

export type PublishTracker = {
  session: string
  status: "triggered" | "failed"
  startedAt: string
  updatedAt: string
  slugs: string[]
  deployStatus?: number
  deployResponse?: string
  inspectUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  vercelState?: string
  lastCheckError?: string
}

export type IssueTouchedEntry = { slugs: string[]; updatedAt: string }

export type PersistedState = {
  publishedPages: PageDoc[]
  draftPages: Record<string, Record<string, PageDoc>>
  historyUndo: Record<string, Record<string, (PageDoc | null)[]>>
  historyRedo: Record<string, Record<string, (PageDoc | null)[]>>
  versions: Record<string, number>
  recentEdits: Record<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>
  chatHistory: Record<string, Array<{ role: "user" | "assistant"; content: string }>>
  siteConfigs?: Record<string, SiteConfig>
  versionLog?: Record<string, VersionEntry[]>
  issueTouchedSlugs?: Record<string, IssueTouchedEntry>
}

// ---------------------------------------------------------------------------
// State maps
// ---------------------------------------------------------------------------
export const publishedPages = new Map<string, PageDoc>()
for (const page of demoPublishedPages()) publishedPages.set(page.slug, structuredClone(page))

export const draftPages = new Map<string, Map<string, PageDoc>>()
export const historyUndo = new Map<string, Map<string, (PageDoc | null)[]>>()
export const historyRedo = new Map<string, Map<string, (PageDoc | null)[]>>()
export const versions = new Map<string, number>()
export const recentEdits = new Map<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>()

export type VersionEntry = {
  version: number
  slug: string
  summary: string
  opTypes: string[]
  opCount: number
  at: string
  source: "chat" | "direct" | "undo" | "redo" | "bootstrap" | "restore"
  /**
   * Full snapshot of the page state at this version. Enables the version
   * history panel to jump back and forth between any two versions directly,
   * independent of the undo/redo stacks. `null` means the page did not exist
   * at this version (e.g. before it was created, or after it was removed).
   * Omit the field when capturing a snapshot is impossible (legacy entries).
   */
  snapshot?: PageDoc | null
}
export const versionLog = new Map<string, VersionEntry[]>()

/**
 * Per-ticket slugs touched by an agent run. Survives the execute→publish
 * invocation gap so the publish-mode comment can list exactly what this
 * ticket changed, rather than every page in the shared session. Capped at
 * ISSUE_TOUCHED_MAX entries (oldest dropped by updatedAt).
 */
export const issueTouchedSlugsByKey = new Map<string, IssueTouchedEntry>()
const ISSUE_TOUCHED_MAX = 200

export function setIssueTouchedSlugs(issueKey: string, slugs: string[]) {
  if (!issueKey) return
  issueTouchedSlugsByKey.set(issueKey, {
    slugs: Array.from(new Set(slugs.filter((s) => typeof s === "string" && s.length > 0))),
    updatedAt: new Date().toISOString(),
  })
  if (issueTouchedSlugsByKey.size > ISSUE_TOUCHED_MAX) {
    const sorted = Array.from(issueTouchedSlugsByKey.entries())
      .sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
    const toDelete = sorted.slice(0, issueTouchedSlugsByKey.size - ISSUE_TOUCHED_MAX)
    for (const [key] of toDelete) issueTouchedSlugsByKey.delete(key)
  }
}

export function getIssueTouchedSlugs(issueKey: string): string[] {
  return issueTouchedSlugsByKey.get(issueKey)?.slugs ?? []
}

export const pendingClarificationBySession = new Map<string, { baseRequest: string; updatedAt: string }>()
export const chatHistoryBySession = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>()
export const pendingApprovalPlanBySession = new Map<string, PendingApprovalPlan>()
/**
 * Per-session image-source preference ("unsplash" | "genai" | "either"), set when
 * the user resolves a source-ambiguity clarification. Stops repeated prompting
 * within the same session. Ephemeral (in-memory) only.
 */
export type ImageSourcePreference = "unsplash" | "genai" | "either"
export const imageSourcePreferenceBySession = new Map<string, ImageSourcePreference>()
export const publishStatusBySession = new Map<string, PublishTracker>()
export const siteConfigs = new Map<string, SiteConfig>()
// Seed default config
siteConfigs.set("avocado-hub::dev", { name: "The Avocado Hub", logo: "/logos/avocado-hub.svg" })
export let lastPublishedScopedSession: string | undefined
export function setLastPublishedScopedSession(key: string) { lastPublishedScopedSession = key }

// Track sessions that were just restored so bootstrap doesn't overwrite them
const recentlyRestoredSessions = new Set<string>()
export function markRecentlyRestored(session: string) { recentlyRestoredSessions.add(session) }
export function consumeRecentlyRestored(session: string): boolean { return recentlyRestoredSessions.delete(session) }

// ---------------------------------------------------------------------------
// Persistence config
// ---------------------------------------------------------------------------
/**
 * Legacy JSON state file path. Resolved lazily each call so tests can
 * point to a temp file via `ORCHESTRATOR_STATE_FILE`. Read only at
 * startup, for one-shot migration into SQLite. Once migrated, the file
 * is renamed to `<path>.migrated-<ts>` and swept after
 * `ORCHESTRATOR_JSON_MIGRATION_TTL_DAYS`.
 */
export function resolveStateFilePath(): string {
  return (
    process.env.ORCHESTRATOR_STATE_FILE ??
    resolve(process.cwd(), "../../.data/orchestrator-state.json")
  )
}

/**
 * Sentinel session key used to store the global `publishedPages` Map in the
 * per-session `pages` table. Picked so it can never collide with a real
 * session key (which is either `<site>::<session>` or a bare session name).
 */
const PUBLISHED_GLOBAL_KEY = "__published_global__"

// ---------------------------------------------------------------------------
// Utility: error detail extractor — canonical impl in ../errors.ts
// ---------------------------------------------------------------------------
export const toErrorDetail = _unifiedToErrorDetail

// ---------------------------------------------------------------------------
// Hero image prop guard (needed by getSessionDraft, setPage, applyPersistedState)
// ---------------------------------------------------------------------------
export function ensureHeroImageProps(page: PageDoc) {
  for (const block of page.blocks) {
    const props = block.props as Record<string, unknown>
    if (block.type === "Hero") {
      // Skip imageUrl fallback if the block uses carouselImages instead
      if (typeof props.imageUrl !== "string" || props.imageUrl.length === 0) {
        if (!Array.isArray(props.carouselImages) || props.carouselImages.length === 0) {
          props.imageUrl = IMAGE_PLACEHOLDER
        }
      }
      if (typeof props.imageAlt !== "string" || props.imageAlt.length === 0) {
        props.imageAlt =
          page.slug === "/pricing"
            ? "Abstract generated illustration for the pricing hero"
            : "Abstract generated illustration for the hero section"
      }
      continue
    }

    if (block.type === "TwoColumn") {
      if (!Array.isArray(props.left) || props.left.length === 0) {
        // Migrate from legacy flat props if present
        const heading = typeof props.heading === "string" ? props.heading
          : typeof props.title === "string" ? props.title : "Section heading"
        const body = typeof props.body === "string" ? props.body
          : typeof props.description === "string" ? props.description : "Section content"
        props.left = [
          { type: "heading", text: heading },
          { type: "paragraph", text: body }
        ]
      }
      if (!Array.isArray(props.right) || props.right.length === 0) {
        const src = typeof props.imageUrl === "string" ? props.imageUrl : IMAGE_PLACEHOLDER
        const alt = typeof props.imageAlt === "string" ? props.imageAlt : "Section image"
        props.right = [{ type: "image", src, alt }]
      }
      if (props.variant !== "default" && props.variant !== "accent") {
        props.variant = "default"
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Slug ordering helper
// ---------------------------------------------------------------------------
export function orderSlugsHomeFirst(slugs: string[]) {
  return slugs.includes("/") ? ["/", ...slugs.filter((route) => route !== "/")] : slugs
}

// ---------------------------------------------------------------------------
// Accessor functions
// ---------------------------------------------------------------------------
/** Resolve monorepo root (orchestrator lives at apps/orchestrator/) */
function monorepoRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), "../../../")
}

/**
 * Try to read a site's content/pages.json synchronously.
 * Returns parsed PageDoc[] or empty array on failure.
 */
function readSitePages(siteId: string): PageDoc[] {
  try {
    const pagesPath = resolve(monorepoRoot(), "apps", siteId, "content", "pages.json")
    if (!existsSync(pagesPath)) return []
    const raw = readFileSync(pagesPath, "utf-8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Try to read a site's content/site-config.json synchronously.
 * Seeds siteConfigs with nav labels, logo, footer, etc.
 */
function seedSiteConfig(session: string, siteId: string): void {
  try {
    const configPath = resolve(monorepoRoot(), "apps", siteId, "content", "site-config.json")
    if (!existsSync(configPath)) return
    const config = JSON.parse(readFileSync(configPath, "utf-8"))
    if (config && typeof config === "object") {
      siteConfigs.set(session, { ...siteConfigs.get(session), ...config })
    }
  } catch { /* ignore */ }
}

export function getSessionDraft(session: string) {
  let sessionMap = draftPages.get(session)
  if (!sessionMap) {
    sessionMap = new Map<string, PageDoc>()

    if (!session.includes("::")) {
      // Legacy/default sessions — seed from published demo pages
      for (const [slug, page] of publishedPages) {
        const copy = structuredClone(page)
        ensureHeroImageProps(copy)
        sessionMap.set(slug, copy)
      }
    } else {
      // Site-scoped sessions — seed from the site's content/pages.json on disk.
      // This ensures migrated sites load immediately without waiting for async bootstrap.
      const siteId = session.split("::")[0]
      const sitePages = readSitePages(siteId)
      if (sitePages.length > 0) {
        for (const page of sitePages) {
          const copy = structuredClone(page)
          ensureHeroImageProps(copy)
          sessionMap.set(copy.slug, copy)
        }
        seedSiteConfig(session, siteId)
        console.log(`[session-state] Seeded ${session} from apps/${siteId}/content/pages.json (${sitePages.length} pages)`)
      }
    }
    draftPages.set(session, sessionMap)
  }
  return sessionMap
}

export function getHistoryMap(store: Map<string, Map<string, (PageDoc | null)[]>>, session: string) {
  let bySession = store.get(session)
  if (!bySession) {
    bySession = new Map<string, (PageDoc | null)[]>()
    store.set(session, bySession)
  }
  return bySession
}

export function getPage(session: string, slug: string) {
  const sessionDraft = getSessionDraft(session)
  return sessionDraft.get(slug) ?? null
}

export function getSessionPages(session: string) {
  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return slugs.map((slug) => structuredClone(draft.get(slug)!))
}

// ---------------------------------------------------------------------------
// Context cache — invalidated on setPage / removePage / bumpVersion
// ---------------------------------------------------------------------------
const _contextCache = new Map<string, { version: number; pageDirectory?: string }>()

export function getContextCache(session: string) {
  return _contextCache.get(session)
}

export function setContextCache(session: string, entry: { version: number; pageDirectory?: string }) {
  _contextCache.set(session, entry)
}

function invalidateContextCache(session: string) {
  _contextCache.delete(session)
}

export function setPage(session: string, page: PageDoc) {
  const sessionDraft = getSessionDraft(session)
  ensureHeroImageProps(page)
  sessionDraft.set(page.slug, page)
  invalidateContextCache(session)
}

export function removePage(session: string, slug: string) {
  const sessionDraft = getSessionDraft(session)
  sessionDraft.delete(slug)
  invalidateContextCache(session)
}

export function pushUndo(session: string, slug: string, snapshot: PageDoc | null) {
  const undoMap = getHistoryMap(historyUndo, session)
  const list = undoMap.get(slug) ?? []
  list.push(snapshot === null ? null : structuredClone(snapshot))
  undoMap.set(slug, list)

  const redoMap = getHistoryMap(historyRedo, session)
  redoMap.set(slug, [])
}

export function bumpVersion(session: string) {
  const current = versions.get(session) ?? 0
  const next = current + 1
  versions.set(session, next)
  invalidateContextCache(session)
  return next
}

export function pushRecentEdit(session: string, entry: { slug: string; summary: string; ops: Operation[] }) {
  const list = recentEdits.get(session) ?? []
  list.push({ ...entry, at: new Date().toISOString() })
  recentEdits.set(session, list.slice(-10))
}

const VERSION_LOG_MAX = 100

export function pushVersionEntry(session: string, entry: Omit<VersionEntry, "at">) {
  const list = versionLog.get(session) ?? []
  list.push({ ...entry, at: new Date().toISOString() })
  versionLog.set(session, list.slice(-VERSION_LOG_MAX))
}

export function getVersionLog(session: string, slug?: string, limit = 50): VersionEntry[] {
  const list = versionLog.get(session) ?? []
  const filtered = slug ? list.filter((e) => e.slug === slug) : list
  return filtered.slice(-limit)
}

export const CHAT_HISTORY_MAX_TURNS = 6

export function pushChatHistory(session: string, userMessage: string, assistantSummary: string) {
  const history = chatHistoryBySession.get(session) ?? []
  history.push({ role: "user", content: userMessage })
  history.push({ role: "assistant", content: assistantSummary })
  chatHistoryBySession.set(session, history.slice(-CHAT_HISTORY_MAX_TURNS))
}

export function getRecentEdits(session: string, slug: string) {
  const list = recentEdits.get(session) ?? []
  return list
    .filter((item) => item.slug === slug)
    .slice(-3)
    .map((item) => ({
      at: item.at,
      summary: item.summary,
      ops: item.ops.map((op) => op.op)
    }))
}

// ---------------------------------------------------------------------------
// Site config accessors
// ---------------------------------------------------------------------------
export function getSiteConfig(session: string): SiteConfig {
  return siteConfigs.get(session) ?? {}
}

export function setSiteConfig(session: string, config: SiteConfig) {
  const existing = siteConfigs.get(session) ?? {}
  siteConfigs.set(session, { ...existing, ...config })
}

/**
 * Walk the in-memory `siteConfigs` map and return one entry per unique siteId,
 * preferring entries that match `wantedSession` over legacy unscoped ones.
 *
 * The map keys come from `scopedSessionKey()`: either `{siteId}::{session}` or
 * just `{session}` for legacy sites (avocado-stories convention). Owning that
 * parsing here keeps route handlers from having to know about the key format.
 */
export function listSitesForSession(
  wantedSession: string
): Array<SiteConfig & { id: string }> {
  const byId = new Map<string, { config: SiteConfig & { id: string }; matchesSession: boolean }>()

  for (const [key, config] of siteConfigs.entries()) {
    const sep = key.indexOf("::")
    const siteId = sep === -1 ? DEFAULT_SITE_ID : key.slice(0, sep)
    const session = sep === -1 ? key : key.slice(sep + 2)
    const matchesSession = session === wantedSession

    const existing = byId.get(siteId)
    if (!existing || (matchesSession && !existing.matchesSession)) {
      byId.set(siteId, {
        config: { id: siteId, ...config },
        matchesSession,
      })
    }
  }

  return Array.from(byId.values()).map((entry) => entry.config)
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
export function nestedPageMapToObject(source: Map<string, Map<string, PageDoc>>) {
  const out: Record<string, Record<string, PageDoc>> = {}
  for (const [session, pages] of source) {
    out[session] = {}
    for (const [slug, page] of pages) out[session][slug] = structuredClone(page)
  }
  return out
}

export function nestedHistoryMapToObject(source: Map<string, Map<string, (PageDoc | null)[]>>) {
  const out: Record<string, Record<string, (PageDoc | null)[]>> = {}
  for (const [session, bySlug] of source) {
    out[session] = {}
    for (const [slug, snapshots] of bySlug) out[session][slug] = snapshots.map((item) => item === null ? null : structuredClone(item))
  }
  return out
}

export function objectToNestedPageMap(source: unknown) {
  const out = new Map<string, Map<string, PageDoc>>()
  if (!source || typeof source !== "object") return out
  for (const [session, pages] of Object.entries(source as Record<string, unknown>)) {
    if (!pages || typeof pages !== "object") continue
    const bySlug = new Map<string, PageDoc>()
    for (const [slug, page] of Object.entries(pages as Record<string, unknown>)) {
      if (!page || typeof page !== "object") continue
      bySlug.set(slug, page as PageDoc)
    }
    out.set(session, bySlug)
  }
  return out
}

export function objectToNestedHistoryMap(source: unknown) {
  const out = new Map<string, Map<string, (PageDoc | null)[]>>()
  if (!source || typeof source !== "object") return out
  for (const [session, bySlugRaw] of Object.entries(source as Record<string, unknown>)) {
    if (!bySlugRaw || typeof bySlugRaw !== "object") continue
    const bySlug = new Map<string, (PageDoc | null)[]>()
    for (const [slug, listRaw] of Object.entries(bySlugRaw as Record<string, unknown>)) {
      if (!Array.isArray(listRaw)) continue
      bySlug.set(slug, listRaw.filter((item) => item === null || (item && typeof item === "object")) as (PageDoc | null)[])
    }
    out.set(session, bySlug)
  }
  return out
}

export function applyPersistedState(parsed: Partial<PersistedState>) {
  if (Array.isArray(parsed.publishedPages) && parsed.publishedPages.length > 0) {
    publishedPages.clear()
    for (const page of parsed.publishedPages) {
      if (!page || typeof page !== "object" || typeof page.slug !== "string") continue
      ensureHeroImageProps(page as PageDoc)
      publishedPages.set(page.slug, page as PageDoc)
    }
  }

  draftPages.clear()
  for (const [session, bySlug] of objectToNestedPageMap(parsed.draftPages)) {
    for (const page of bySlug.values()) ensureHeroImageProps(page)
    draftPages.set(session, bySlug)
  }

  historyUndo.clear()
  for (const [session, bySlug] of objectToNestedHistoryMap(parsed.historyUndo)) historyUndo.set(session, bySlug)

  historyRedo.clear()
  for (const [session, bySlug] of objectToNestedHistoryMap(parsed.historyRedo)) historyRedo.set(session, bySlug)

  versions.clear()
  if (parsed.versions && typeof parsed.versions === "object") {
    for (const [session, value] of Object.entries(parsed.versions)) {
      if (typeof value === "number" && Number.isFinite(value)) versions.set(session, value)
    }
  }

  recentEdits.clear()
  if (parsed.recentEdits && typeof parsed.recentEdits === "object") {
    for (const [session, listRaw] of Object.entries(parsed.recentEdits)) {
      if (!Array.isArray(listRaw)) continue
      const list = listRaw
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => entry as { slug: string; summary: string; ops: Operation[]; at: string })
      recentEdits.set(session, list.slice(-10))
    }
  }

  chatHistoryBySession.clear()
  if (parsed.chatHistory && typeof parsed.chatHistory === "object") {
    for (const [session, listRaw] of Object.entries(parsed.chatHistory)) {
      if (!Array.isArray(listRaw)) continue
      const list = listRaw
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            (entry.role === "user" || entry.role === "assistant") &&
            typeof entry.content === "string"
        )
        .map((entry) => entry as { role: "user" | "assistant"; content: string })
      chatHistoryBySession.set(session, list.slice(-CHAT_HISTORY_MAX_TURNS))
    }
  }

  siteConfigs.clear()
  // Re-seed default
  siteConfigs.set("avocado-hub::dev", { name: "The Avocado Hub", logo: "/logos/avocado-hub.svg" })
  if (parsed.siteConfigs && typeof parsed.siteConfigs === "object") {
    for (const [session, config] of Object.entries(parsed.siteConfigs)) {
      if (config && typeof config === "object") {
        siteConfigs.set(session, config as SiteConfig)
      }
    }
  }

  versionLog.clear()
  if (parsed.versionLog && typeof parsed.versionLog === "object") {
    for (const [session, listRaw] of Object.entries(parsed.versionLog)) {
      if (!Array.isArray(listRaw)) continue
      const list = listRaw
        .filter((entry) => entry && typeof entry === "object" && typeof entry.version === "number")
        .map((entry) => entry as VersionEntry)
      versionLog.set(session, list.slice(-VERSION_LOG_MAX))
    }
  }

  issueTouchedSlugsByKey.clear()
  if (parsed.issueTouchedSlugs && typeof parsed.issueTouchedSlugs === "object") {
    for (const [issueKey, entryRaw] of Object.entries(parsed.issueTouchedSlugs)) {
      if (!entryRaw || typeof entryRaw !== "object") continue
      const entry = entryRaw as Partial<IssueTouchedEntry>
      if (!Array.isArray(entry.slugs)) continue
      const slugs = entry.slugs.filter((s): s is string => typeof s === "string" && s.length > 0)
      const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString()
      issueTouchedSlugsByKey.set(issueKey, { slugs, updatedAt })
    }
  }
}

// ---------------------------------------------------------------------------
// SQLite persistence (Phase 2+)
// ---------------------------------------------------------------------------
/**
 * Snapshot every in-memory Map into SQLite inside a single transaction.
 * Callers are `schedulePersistState` (hot path) and one-shot migrations.
 *
 * Tradeoff: this writes every session every call, not just the mutated one.
 * Because SQLite in WAL mode wraps the whole thing in one fsync and our
 * state is small (<1 MB typical), it stays sub-millisecond. Per-session
 * write-through is a future optimization if writes ever become hot.
 */
function writeAllStateToStore(store: SqliteStore) {
  store.transaction(() => {
    // Pages — drop-all-then-reinsert so deletes propagate. Cheap for our sizes.
    store.db.prepare("DELETE FROM pages").run()
    for (const [slug, page] of publishedPages) {
      store.db.prepare(
        "INSERT INTO pages(session, slug, kind, doc) VALUES (?, ?, 'published', ?)"
      ).run(PUBLISHED_GLOBAL_KEY, slug, JSON.stringify(page))
    }
    for (const [session, bySlug] of draftPages) {
      for (const [slug, page] of bySlug) {
        store.db.prepare(
          "INSERT INTO pages(session, slug, kind, doc) VALUES (?, ?, 'draft', ?)"
        ).run(session, slug, JSON.stringify(page))
      }
    }
    // History — drop + reinsert so pops propagate.
    store.db.prepare("DELETE FROM history").run()
    const insertHist = store.db.prepare(
      "INSERT INTO history(session, slug, direction, seq, snapshot) VALUES (?, ?, ?, ?, ?)"
    )
    for (const [session, bySlug] of historyUndo) {
      for (const [slug, list] of bySlug) {
        list.forEach((snap, i) =>
          insertHist.run(session, slug, "undo", i + 1, snap === null ? null : JSON.stringify(snap))
        )
      }
    }
    for (const [session, bySlug] of historyRedo) {
      for (const [slug, list] of bySlug) {
        list.forEach((snap, i) =>
          insertHist.run(session, slug, "redo", i + 1, snap === null ? null : JSON.stringify(snap))
        )
      }
    }
    // Versions
    store.db.prepare("DELETE FROM sessions").run()
    for (const [session, v] of versions) store.setVersion(session, v)

    // Version log
    store.db.prepare("DELETE FROM version_log").run()
    const insertVLog = store.db.prepare(
      "INSERT INTO version_log(session, seq, entry) VALUES (?, ?, ?)"
    )
    for (const [session, list] of versionLog) {
      list.forEach((entry, i) => insertVLog.run(session, i + 1, JSON.stringify(entry)))
    }

    // Recent edits
    store.db.prepare("DELETE FROM recent_edits").run()
    const insertEdit = store.db.prepare(
      "INSERT INTO recent_edits(session, seq, entry) VALUES (?, ?, ?)"
    )
    for (const [session, list] of recentEdits) {
      list.forEach((entry, i) => insertEdit.run(session, i + 1, JSON.stringify(entry)))
    }

    // Chat history
    store.db.prepare("DELETE FROM chat_history").run()
    const insertChat = store.db.prepare(
      "INSERT INTO chat_history(session, seq, role, content) VALUES (?, ?, ?, ?)"
    )
    for (const [session, list] of chatHistoryBySession) {
      list.forEach((m, i) => insertChat.run(session, i + 1, m.role, m.content))
    }

    // Site configs
    store.db.prepare("DELETE FROM site_configs").run()
    for (const [session, cfg] of siteConfigs) store.setSiteConfig(session, cfg)

    // Issue-touched
    store.db.prepare("DELETE FROM issue_touched").run()
    for (const [key, row] of issueTouchedSlugsByKey) store.setIssueTouched(key, row)
  })
}

/**
 * Hydrate the in-memory Maps from a SqliteStore. Caller must have cleared
 * the Maps first if they want authoritative replacement.
 */
function hydrateMapsFromStore(store: SqliteStore) {
  // Published (global) pages live under PUBLISHED_GLOBAL_KEY.
  for (const page of store.listPages(PUBLISHED_GLOBAL_KEY, "published")) {
    ensureHeroImageProps(page)
    publishedPages.set(page.slug, page)
  }

  // Draft pages — walk every session except the sentinel.
  for (const session of store.listDraftSessions()) {
    if (session === PUBLISHED_GLOBAL_KEY) continue
    const bySlug = new Map<string, PageDoc>()
    for (const page of store.listPages(session, "draft")) {
      ensureHeroImageProps(page)
      bySlug.set(page.slug, page)
    }
    if (bySlug.size > 0) draftPages.set(session, bySlug)
  }

  // History — need a list of sessions/slugs. We rely on the fact that any
  // session with history also has draft pages, plus a fallback scan via the
  // session-slug pairs already captured in the DB.
  const histRows = store.db
    .prepare(
      `SELECT session, slug, direction, seq, snapshot FROM history ORDER BY session, slug, direction, seq`
    )
    .all() as Array<{
      session: string
      slug: string
      direction: "undo" | "redo"
      seq: number
      snapshot: string | null
    }>
  for (const row of histRows) {
    const target = row.direction === "undo" ? historyUndo : historyRedo
    let bySlug = target.get(row.session)
    if (!bySlug) {
      bySlug = new Map()
      target.set(row.session, bySlug)
    }
    const list = bySlug.get(row.slug) ?? []
    list.push(row.snapshot === null ? null : (JSON.parse(row.snapshot) as PageDoc))
    bySlug.set(row.slug, list)
  }

  // Versions
  const versionRows = store.db
    .prepare("SELECT session, version FROM sessions")
    .all() as Array<{ session: string; version: number }>
  for (const r of versionRows) versions.set(r.session, r.version)

  // Version log
  const vlogSessions = store.db
    .prepare("SELECT DISTINCT session FROM version_log")
    .all() as Array<{ session: string }>
  for (const { session } of vlogSessions) {
    versionLog.set(session, store.listVersionLog(session, undefined, VERSION_LOG_MAX))
  }

  // Recent edits
  const editSessions = store.db
    .prepare("SELECT DISTINCT session FROM recent_edits")
    .all() as Array<{ session: string }>
  for (const { session } of editSessions) {
    recentEdits.set(session, store.listRecentEdits(session))
  }

  // Chat history
  const chatSessions = store.db
    .prepare("SELECT DISTINCT session FROM chat_history")
    .all() as Array<{ session: string }>
  for (const { session } of chatSessions) {
    chatHistoryBySession.set(session, store.listChatHistory(session))
  }

  // Site configs
  for (const { session, config } of store.listSiteConfigs()) {
    siteConfigs.set(session, config)
  }

  // Issue-touched
  for (const { issueKey, row } of store.listIssueTouched()) {
    issueTouchedSlugsByKey.set(issueKey, row)
  }
}

/**
 * Persist the current in-memory state to SQLite. Synchronous internally
 * (better-sqlite3 is sync) but async-compatible for callers that want to
 * `await` it (publish flow does).
 */
export async function persistStateNow(logger: FastifyBaseLogger) {
  try {
    writeAllStateToStore(getStore())
  } catch (error) {
    logger.error(
      { err: toErrorDetail(error) },
      "Failed to persist orchestrator state to SQLite"
    )
    throw error
  }
}

/**
 * Same semantics as before: schedule a persist. The 80ms debounce is gone
 * (SQLite+WAL handles per-call writes fine), so this is now synchronous
 * best-effort — any write error is logged, not propagated.
 */
export function schedulePersistState(logger: FastifyBaseLogger) {
  try {
    writeAllStateToStore(getStore())
  } catch (error) {
    logger.error(
      { err: toErrorDetail(error) },
      "Failed to persist orchestrator state to SQLite"
    )
  }
}

export async function loadStateFromDisk(logger: FastifyBaseLogger) {
  let store: SqliteStore
  try {
    store = getStore()
  } catch (error) {
    logger.error(
      { err: toErrorDetail(error) },
      "Failed to open orchestrator SQLite store"
    )
    return
  }

  const jsonPath = resolveStateFilePath()
  // Sweep stale .json.migrated-<ts> siblings first; never blocks startup.
  void sweepStaleMigrations(jsonPath, resolveJsonMigrationTtlDays(), logger)

  // If SQLite already has state, just hydrate from it.
  const sessionsSeeded = (store.db
    .prepare("SELECT COUNT(*) AS n FROM pages")
    .get() as { n: number }).n > 0
  if (sessionsSeeded) {
    hydrateMapsFromStore(store)
    logger.info({ backend: "sqlite" }, "Loaded persisted orchestrator state")
    return
  }

  // DB is empty — migrate from legacy JSON if it exists.
  if (!existsSync(jsonPath)) {
    logger.info({ backend: "sqlite" }, "No prior orchestrator state; starting fresh")
    return
  }
  try {
    const parsed = await readLegacyJson<Partial<PersistedState>>(jsonPath)
    if (parsed) {
      applyPersistedState(parsed)
      writeAllStateToStore(store)
      const archived = await archiveMigratedJson(jsonPath)
      logger.info(
        { file: jsonPath, archived },
        "Migrated orchestrator state from JSON to SQLite"
      )
    } else {
      logger.info({ file: jsonPath }, "Legacy JSON state file was empty; ignoring")
    }
  } catch (error) {
    logger.error(
      { err: toErrorDetail(error), file: jsonPath },
      "Failed to migrate orchestrator state from JSON"
    )
  }
}

// ---------------------------------------------------------------------------
// ContentSource interface + InMemoryContentSource re-exports
// ---------------------------------------------------------------------------
export type { ContentSource } from "./content-source.js"
export { InMemoryContentSource } from "./in-memory-content-source.js"
