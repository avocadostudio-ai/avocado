import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
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

// ---------------------------------------------------------------------------
// ModelKey inline type (avoids circular dependency with index.ts)
// ---------------------------------------------------------------------------
export type ModelKey = "fast" | "balanced" | "reasoning" | "codex"
export type AIProvider = "openai" | "anthropic"

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

export function scopedSessionKey(session: unknown, siteId: unknown) {
  const normalizedSession = normalizeSession(session)
  const normalizedSiteId = normalizeSiteId(siteId)
  if (normalizedSiteId === "avocado-stories" || normalizedSiteId === "default") {
    // Keep Avocado Stories on legacy session keys so existing content is preserved.
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
  source: "openai" | "anthropic" | "demo"
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

export type PersistedState = {
  publishedPages: PageDoc[]
  draftPages: Record<string, Record<string, PageDoc>>
  historyUndo: Record<string, Record<string, (PageDoc | null)[]>>
  historyRedo: Record<string, Record<string, (PageDoc | null)[]>>
  versions: Record<string, number>
  recentEdits: Record<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>
  chatHistory: Record<string, Array<{ role: "user" | "assistant"; content: string }>>
  siteConfigs?: Record<string, SiteConfig>
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
export const pendingClarificationBySession = new Map<string, { baseRequest: string; updatedAt: string }>()
export const chatHistoryBySession = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>()
export const pendingApprovalPlanBySession = new Map<string, PendingApprovalPlan>()
export const publishStatusBySession = new Map<string, PublishTracker>()
export const siteConfigs = new Map<string, SiteConfig>()
// Seed default config for avocado-stories
siteConfigs.set("dev", { name: "Avocado Stories", logo: "/logos/avocado-stories.svg" })
export let lastPublishedScopedSession: string | undefined
export function setLastPublishedScopedSession(key: string) { lastPublishedScopedSession = key }

// ---------------------------------------------------------------------------
// Persistence config constants
// ---------------------------------------------------------------------------
export const stateFilePath =
  process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../.data/orchestrator-state.json")
export const stateBackupDir = resolve(stateFilePath, "..")
const stateFileBase = basename(stateFilePath).replace(/\.json$/i, "")
export const stateBackupPrefix = `${stateFileBase}.backup-`
const stateBackupLimitRaw = Number(process.env.ORCHESTRATOR_STATE_BACKUP_LIMIT ?? 40)
export const stateBackupLimit =
  Number.isFinite(stateBackupLimitRaw) && stateBackupLimitRaw >= 5 ? Math.floor(stateBackupLimitRaw) : 40
const stateBackupMinIntervalRaw = Number(process.env.ORCHESTRATOR_STATE_BACKUP_MIN_INTERVAL_MS ?? 120000)
export const stateBackupMinIntervalMs =
  Number.isFinite(stateBackupMinIntervalRaw) && stateBackupMinIntervalRaw >= 1000
    ? Math.floor(stateBackupMinIntervalRaw)
    : 120000

export let persistTimer: NodeJS.Timeout | null = null
export let lastStateBackupAt = 0

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
export function getSessionDraft(session: string) {
  let sessionMap = draftPages.get(session)
  if (!sessionMap) {
    sessionMap = new Map<string, PageDoc>()
    // Legacy/default sessions are seeded from published pages so the orchestrator can
    // serve content immediately. The editor's bootstrapFromSite() will overwrite this
    // with the site's actual published-content.json on first load.
    // Site-scoped sessions (<siteId>::<session>) start empty and are bootstrapped explicitly.
    if (!session.includes("::")) {
      for (const [slug, page] of publishedPages) {
        const copy = structuredClone(page)
        ensureHeroImageProps(copy)
        sessionMap.set(slug, copy)
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
  siteConfigs.set("dev", { name: "Avocado Stories", logo: "/logos/avocado-stories.svg" })
  if (parsed.siteConfigs && typeof parsed.siteConfigs === "object") {
    for (const [session, config] of Object.entries(parsed.siteConfigs)) {
      if (config && typeof config === "object") {
        siteConfigs.set(session, config as SiteConfig)
      }
    }
  }
}

async function rotateStateBackups(logger: FastifyBaseLogger) {
  try {
    const entries = await readdir(stateBackupDir)
    const backupFiles = entries
      .filter((name) => name.startsWith(stateBackupPrefix) && name.endsWith(".json"))
      .sort()
    if (backupFiles.length <= stateBackupLimit) return
    const toDelete = backupFiles.slice(0, backupFiles.length - stateBackupLimit)
    await Promise.all(
      toDelete.map(async (name) => {
        try {
          await unlink(resolve(stateBackupDir, name))
        } catch {
          // Ignore cleanup failures; retaining extra backups is acceptable.
        }
      })
    )
  } catch {
    // Ignore backup rotation failures; state persistence must continue.
  }
  void logger
}

async function createStateBackup(reason: "persist" | "startup", logger: FastifyBaseLogger, force = false) {
  if (!existsSync(stateFilePath)) return
  const now = Date.now()
  if (!force && now - lastStateBackupAt < stateBackupMinIntervalMs) return
  await mkdir(stateBackupDir, { recursive: true })
  const stamp = new Date(now).toISOString().replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z")
  const backupPath = resolve(stateBackupDir, `${stateBackupPrefix}${stamp}.json`)
  const raw = await readFile(stateFilePath, "utf8")
  await writeFile(backupPath, raw, "utf8")
  lastStateBackupAt = now
  await rotateStateBackups(logger)
  logger.info({ file: backupPath, reason }, "Created orchestrator state backup")
}

async function tryLoadStateFromLatestBackup(logger: FastifyBaseLogger) {
  try {
    const entries = await readdir(stateBackupDir)
    const backupFiles = entries
      .filter((name) => name.startsWith(stateBackupPrefix) && name.endsWith(".json"))
      .sort()
      .reverse()
    for (const name of backupFiles) {
      try {
        const file = resolve(stateBackupDir, name)
        const raw = await readFile(file, "utf8")
        const parsed = JSON.parse(raw) as Partial<PersistedState>
        applyPersistedState(parsed)
        logger.warn({ file }, "Recovered orchestrator state from backup")
        return true
      } catch {
        // Try older backup.
      }
    }
  } catch {
    // Ignore backup lookup failures.
  }
  return false
}

export async function persistStateNow(logger: FastifyBaseLogger) {
  await createStateBackup("persist", logger)
  const payload: PersistedState = {
    publishedPages: Array.from(publishedPages.values()).map((page) => structuredClone(page)),
    draftPages: nestedPageMapToObject(draftPages),
    historyUndo: nestedHistoryMapToObject(historyUndo),
    historyRedo: nestedHistoryMapToObject(historyRedo),
    versions: Object.fromEntries(versions.entries()),
    recentEdits: Object.fromEntries(recentEdits.entries()),
    chatHistory: Object.fromEntries(chatHistoryBySession.entries()),
    siteConfigs: Object.fromEntries(siteConfigs.entries())
  }
  await mkdir(resolve(stateFilePath, ".."), { recursive: true })
  const tempPath = `${stateFilePath}.tmp-${process.pid}`
  await writeFile(tempPath, JSON.stringify(payload), "utf8")
  await rename(tempPath, stateFilePath)
}

export function schedulePersistState(logger: FastifyBaseLogger) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void persistStateNow(logger).catch((error: unknown) => {
      logger.error({ err: toErrorDetail(error) }, "Failed to persist orchestrator state")
    })
  }, 80)
}

export async function loadStateFromDisk(logger: FastifyBaseLogger) {
  if (!existsSync(stateFilePath)) return
  try {
    await createStateBackup("startup", logger, true)
    const raw = await readFile(stateFilePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    applyPersistedState(parsed)
    logger.info({ file: stateFilePath }, "Loaded persisted orchestrator state")
  } catch (error) {
    logger.error({ err: toErrorDetail(error), file: stateFilePath }, "Failed to load persisted orchestrator state")
    const recovered = await tryLoadStateFromLatestBackup(logger)
    if (!recovered) {
      logger.error("No usable orchestrator state backup found")
    }
  }
}

// ---------------------------------------------------------------------------
// ContentSource interface + InMemoryContentSource re-exports
// ---------------------------------------------------------------------------
export type { ContentSource } from "./content-source.js"
export { InMemoryContentSource } from "./in-memory-content-source.js"
