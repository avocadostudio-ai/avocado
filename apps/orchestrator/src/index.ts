import dotenv from "dotenv"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import OpenAI from "openai"
import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  demoPublishedPages,
  editPlanSchema,
  operationSchema,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc,
  validateBlockProps
} from "@ai-site-editor/shared"

const app = Fastify({ logger: true })
await app.register(cors, { origin: true })
const execFileAsync = promisify(execFile)

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenv.config({ path })
    break
  }
}

const publishedPages = new Map<string, PageDoc>()
for (const page of demoPublishedPages()) publishedPages.set(page.slug, structuredClone(page))

const draftPages = new Map<string, Map<string, PageDoc>>()
const historyUndo = new Map<string, Map<string, PageDoc[]>>()
const historyRedo = new Map<string, Map<string, PageDoc[]>>()
const versions = new Map<string, number>()
const recentEdits = new Map<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>()
type PublishTracker = {
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
const publishStatusBySession = new Map<string, PublishTracker>()
const stateFilePath = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../.data/orchestrator-state.json")
let persistTimer: NodeJS.Timeout | null = null

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function findStringByKeys(root: unknown, wanted: Set<string>): string | undefined {
  if (!root || typeof root !== "object") return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findStringByKeys(item, wanted)
      if (found) return found
    }
    return undefined
  }
  const obj = root as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && wanted.has(key)) return value
    if (value && typeof value === "object") {
      const found = findStringByKeys(value, wanted)
      if (found) return found
    }
  }
  return undefined
}

function firstUrlFromText(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"']+/)
  return match ? match[0] : undefined
}

function deploymentIdFromAny(input: string): string | undefined {
  const match = input.match(/\b(dpl_[a-zA-Z0-9]+)\b/)
  return match?.[1]
}

async function refreshPublishStatusFromVercel(current: PublishTracker) {
  const token = process.env.VERCEL_TOKEN?.trim()
  if (!token || !current.deploymentId) return current

  const teamId = process.env.VERCEL_TEAM_ID?.trim()
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""
  try {
    const res = await fetch(`https://api.vercel.com/v13/deployments/${current.deploymentId}${query}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      current.lastCheckError = `vercel_api_${res.status}`
      current.updatedAt = new Date().toISOString()
      return current
    }

    const payload = (await res.json()) as { readyState?: unknown; url?: unknown; inspectorUrl?: unknown }
    const readyState = typeof payload.readyState === "string" ? payload.readyState.toUpperCase() : undefined
    const url = typeof payload.url === "string" && payload.url.length > 0 ? `https://${payload.url}` : undefined
    const inspectorUrl = typeof payload.inspectorUrl === "string" && payload.inspectorUrl.length > 0 ? payload.inspectorUrl : undefined

    current.vercelState = readyState ?? current.vercelState
    current.deploymentUrl = url ?? current.deploymentUrl
    current.inspectUrl = inspectorUrl ?? current.inspectUrl
    current.lastCheckError = undefined
    current.updatedAt = new Date().toISOString()
    return current
  } catch (error) {
    current.lastCheckError = toErrorDetail(error)
    current.updatedAt = new Date().toISOString()
    return current
  }
}

function requirePublishToken(request: { headers: Record<string, unknown> }) {
  const configured = process.env.PUBLISH_TOKEN?.trim()
  if (!configured) return true
  const provided = String(request.headers["x-publish-token"] ?? "").trim()
  return provided.length > 0 && provided === configured
}

async function runGit(args: string[], cwd: string) {
  const result = await execFileAsync("git", args, { cwd })
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function sanitizeBranch(input: string) {
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : "main"
}

async function publishViaGit(session: string) {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const absoluteTargetPath = resolve(repoRoot, targetPath)
  const branch = sanitizeBranch(process.env.PUBLISH_GIT_BRANCH ?? "main")
  const strict = process.env.PUBLISH_GIT_STRICT === "1"
  const pages = getSessionPages(session)
  const slugs = pages.map((page) => page.slug)
  const payload = `${JSON.stringify(pages, null, 2)}\n`

  await writeFile(absoluteTargetPath, payload, "utf8")

  const statusRaw = await runGit(["status", "--porcelain"], repoRoot)
  const statusLines = statusRaw.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (strict) {
    const blocking = statusLines.filter((line) => !line.endsWith(` ${targetPath}`) && !line.endsWith(` ${targetPath.replace(/\//g, "\\/")}`))
    if (blocking.length > 0) {
      return {
        status: "failed" as const,
        session,
        slugs,
        reason: "working_tree_not_clean",
        details: blocking.slice(0, 12)
      }
    }
  }

  await runGit(["add", targetPath], repoRoot)
  const commitMessage = `publish: session ${session} ${new Date().toISOString()}`

  try {
    await runGit(["commit", "-m", commitMessage], repoRoot)
  } catch (error) {
    const detail = toErrorDetail(error)
    if (detail.includes("nothing to commit")) {
      return {
        status: "ready" as const,
        session,
        slugs,
        branch,
        message: "No content changes to publish."
      }
    }
    return {
      status: "failed" as const,
      session,
      slugs,
      reason: "commit_failed",
      details: [detail]
    }
  }

  let headSha = ""
  try {
    const rev = await runGit(["rev-parse", "HEAD"], repoRoot)
    headSha = rev.stdout.trim()
  } catch {
    // Ignore; commit succeeded.
  }

  try {
    await runGit(["push", "origin", branch], repoRoot)
    return {
      status: "triggered" as const,
      session,
      slugs,
      branch,
      commitSha: headSha || undefined,
      vercelState: "TRIGGERED"
    }
  } catch (error) {
    return {
      status: "failed" as const,
      session,
      slugs,
      branch,
      commitSha: headSha || undefined,
      reason: "push_failed",
      details: [toErrorDetail(error)]
    }
  }
}

function ensureHeroImageProps(page: PageDoc) {
  for (const block of page.blocks) {
    if (block.type !== "Hero") continue
    const props = block.props as Record<string, unknown>
    if (typeof props.imageUrl !== "string" || props.imageUrl.length === 0) {
      props.imageUrl = "/hero-generated.svg"
    }
    if (typeof props.imageAlt !== "string" || props.imageAlt.length === 0) {
      props.imageAlt = page.slug === "/pricing" ? "Abstract generated illustration for the pricing hero" : "Abstract generated illustration for the hero section"
    }
  }
}

const modelLookup = {
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o",
  reasoning: process.env.OPENAI_MODEL_REASONING ?? "gpt-5",
  codex: process.env.OPENAI_MODEL_CODEX ?? "gpt-5-codex"
} as const

type ModelKey = keyof typeof modelLookup
type ChatRequestBody = {
  session?: string
  slug?: string
  message?: string
  modelKey?: ModelKey
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

type ApplyOpsRequestBody = {
  session?: string
  ops?: unknown
}

type ChatResult = {
  status: string
  summary: string
  changes: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  validationErrors?: unknown
  previewVersion: number
  focusBlockId?: string
  updatedSlug?: string
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}

function openAIChatOptionsForModel(model: string) {
  // gpt-5 family rejects temperature=0 in chat.completions; omit to use model default.
  if (model.startsWith("gpt-5")) return {}
  return { temperature: 0 as const }
}

function isInfoQuery(message: string) {
  const m = message.toLowerCase()
  const normalized = m.replace(/\s+/g, " ").trim()
  const blockCatalogPatterns = [
    /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
    /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
    /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
    /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
    /\bwhat\s+else\s+can\s+i\s+add\b/,
    /\bwhat\s+other\s+content\b/,
    /\bavailable\s+blocks?\b/,
    /\bavailable\s+block\s+types?\b/
  ]
  if (blockCatalogPatterns.some((re) => re.test(normalized))) return true

  return (
    m.includes("what blocks can you add") ||
    m.includes("what block can you add") ||
    m.includes("which blocks can you add") ||
    m.includes("which block types can i add") ||
    m.includes("what block types can i add") ||
    m.includes("available blocks") ||
    m.includes("what can i change") ||
    m.includes("what can i edit") ||
    m.includes("what content") ||
    m.includes("content elements") ||
    m.includes("which fields") ||
    m.includes("what fields") ||
    m.includes("what properties") ||
    m.includes("what props")
  )
}

function isBlockCatalogQuery(message: string) {
  const m = message.toLowerCase().replace(/\s+/g, " ").trim()
  return (
    /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/.test(m) ||
    /\bwhat\s+else\s+can\s+i\s+add\b/.test(m) ||
    /\bavailable\s+blocks?\b/.test(m) ||
    /\bavailable\s+block\s+types?\b/.test(m)
  )
}

function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Change heading to \"...\"",
    subheading: "Change subheading to \"...\"",
    ctaText: "Change CTA text to \"...\"",
    ctaHref: "Change CTA link to \"/...\"",
    imageUrl: "Update hero image (e.g. picsum.photos/seed/topic/1600/900)",
    imageAlt: "Change image alt text to \"...\"",
    secondaryCtaText: "Add secondary CTA button \"...\"",
    secondaryCtaHref: "Change secondary CTA link to \"/...\"",
    body: "Edit body text to \"...\"",
    title: "Change title to \"...\"",
    description: "Change description to \"...\"",
    features: "Update feature list",
    items: "Update items",
    cards: "Update cards"
  }
  return labels[propKey] ?? `Change ${propKey} to \"...\"`
}

function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${root}.title to \"...\"`,
      `Update ${root}.description to \"...\"`,
      `Update ${root}.ctaText to \"...\"`,
      `Update ${root}.ctaHref to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${root}.title to \"...\"`, `Update ${root}.description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${root}.quote to \"...\"`, `Update ${root}.author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${root}.q to \"...\"`, `Update ${root}.a to \"...\"`]
  }

  return [`Update ${root} ...`]
}

function infoResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args
  const lower = (body.message ?? "").toLowerCase()

  const asksBlockTypes =
    lower.includes("what blocks can you add") ||
    lower.includes("what block can you add") ||
    lower.includes("which blocks can you add") ||
    lower.includes("which block types can i add") ||
    lower.includes("what block types can i add") ||
    lower.includes("available blocks")

  if (asksBlockTypes) {
    return {
      code: 200,
      payload: {
        status: "info",
        summary: `You can add these block types: ${allowedBlockTypes.join(", ")}.`,
        changes: ["Tip: specify position, e.g. “add Testimonials below Hero”."],
        suggestions: [
          "Add Testimonials below Hero",
          "Add CardGrid at the end",
          "Add FeatureGrid after Hero",
          "Add FAQAccordion before CTA",
          "Add CTA at the end"
        ],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const selected =
    body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
      ? current.blocks.find((b) => b.id === body.activeBlockId)
      : null

  if (selected) {
    const keys = editablePropsFromBlock(selected)
    const childPath = String(body.activeEditablePath ?? "")
    const suggestions = childPath ? childSuggestions({ selected, editablePath: childPath }) : keys.slice(0, 4).map(promptFromPropKey)
    const summary = childPath
      ? `Focused ${selected.type} item: ${childPath}.`
      : `You can edit ${selected.type} fields: ${keys.join(", ")}.`
    return {
      code: 200,
      payload: {
        status: "info",
        summary,
        changes: childPath
          ? [`Selected block: ${selected.id}`, `Focused path: ${childPath}`]
          : [`Selected block: ${selected.id}`, "Tip: click a field name in your prompt, e.g. “change heading to …”."],
        suggestions,
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const firstByType = new Map<BlockType, PageDoc["blocks"][number]>()
  for (const block of current.blocks) {
    if (!firstByType.has(block.type)) firstByType.set(block.type, block)
  }
  const byType = Array.from(firstByType.values()).map((b) => `${b.type}: ${editablePropsFromBlock(b).join(", ")}`)
  return {
    code: 200,
    payload: {
      status: "info",
      summary: "Select a block to get precise editable fields. Current page supports:",
      changes: byType,
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

function getSessionDraft(session: string) {
  let sessionMap = draftPages.get(session)
  if (!sessionMap) {
    sessionMap = new Map<string, PageDoc>()
    for (const [slug, page] of publishedPages) {
      const copy = structuredClone(page)
      ensureHeroImageProps(copy)
      sessionMap.set(slug, copy)
    }
    draftPages.set(session, sessionMap)
  }
  return sessionMap
}

function getHistoryMap(store: Map<string, Map<string, PageDoc[]>>, session: string) {
  let bySession = store.get(session)
  if (!bySession) {
    bySession = new Map<string, PageDoc[]>()
    store.set(session, bySession)
  }
  return bySession
}

function getPage(session: string, slug: string) {
  const sessionDraft = getSessionDraft(session)
  return sessionDraft.get(slug) ?? null
}

function getSessionPages(session: string) {
  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return slugs.map((slug) => structuredClone(draft.get(slug)!))
}

function setPage(session: string, page: PageDoc) {
  const sessionDraft = getSessionDraft(session)
  ensureHeroImageProps(page)
  sessionDraft.set(page.slug, page)
}

function pushUndo(session: string, slug: string, snapshot: PageDoc) {
  const undoMap = getHistoryMap(historyUndo, session)
  const list = undoMap.get(slug) ?? []
  list.push(structuredClone(snapshot))
  undoMap.set(slug, list)

  const redoMap = getHistoryMap(historyRedo, session)
  redoMap.set(slug, [])
}

function bumpVersion(session: string) {
  const current = versions.get(session) ?? 0
  const next = current + 1
  versions.set(session, next)
  return next
}

function pushRecentEdit(session: string, entry: { slug: string; summary: string; ops: Operation[] }) {
  const list = recentEdits.get(session) ?? []
  list.push({ ...entry, at: new Date().toISOString() })
  recentEdits.set(session, list.slice(-10))
}

type PersistedState = {
  publishedPages: PageDoc[]
  draftPages: Record<string, Record<string, PageDoc>>
  historyUndo: Record<string, Record<string, PageDoc[]>>
  historyRedo: Record<string, Record<string, PageDoc[]>>
  versions: Record<string, number>
  recentEdits: Record<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>
}

function nestedPageMapToObject(source: Map<string, Map<string, PageDoc>>) {
  const out: Record<string, Record<string, PageDoc>> = {}
  for (const [session, pages] of source) {
    out[session] = {}
    for (const [slug, page] of pages) out[session][slug] = structuredClone(page)
  }
  return out
}

function nestedHistoryMapToObject(source: Map<string, Map<string, PageDoc[]>>) {
  const out: Record<string, Record<string, PageDoc[]>> = {}
  for (const [session, bySlug] of source) {
    out[session] = {}
    for (const [slug, snapshots] of bySlug) out[session][slug] = snapshots.map((item) => structuredClone(item))
  }
  return out
}

function objectToNestedPageMap(source: unknown) {
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

function objectToNestedHistoryMap(source: unknown) {
  const out = new Map<string, Map<string, PageDoc[]>>()
  if (!source || typeof source !== "object") return out
  for (const [session, bySlugRaw] of Object.entries(source as Record<string, unknown>)) {
    if (!bySlugRaw || typeof bySlugRaw !== "object") continue
    const bySlug = new Map<string, PageDoc[]>()
    for (const [slug, listRaw] of Object.entries(bySlugRaw as Record<string, unknown>)) {
      if (!Array.isArray(listRaw)) continue
      bySlug.set(slug, listRaw.filter((item) => item && typeof item === "object") as PageDoc[])
    }
    out.set(session, bySlug)
  }
  return out
}

async function persistStateNow() {
  const payload: PersistedState = {
    publishedPages: Array.from(publishedPages.values()).map((page) => structuredClone(page)),
    draftPages: nestedPageMapToObject(draftPages),
    historyUndo: nestedHistoryMapToObject(historyUndo),
    historyRedo: nestedHistoryMapToObject(historyRedo),
    versions: Object.fromEntries(versions.entries()),
    recentEdits: Object.fromEntries(recentEdits.entries())
  }
  await mkdir(resolve(stateFilePath, ".."), { recursive: true })
  await writeFile(stateFilePath, JSON.stringify(payload), "utf8")
}

function schedulePersistState() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void persistStateNow().catch((error: unknown) => {
      app.log.error({ err: toErrorDetail(error) }, "Failed to persist orchestrator state")
    })
  }, 80)
}

async function loadStateFromDisk() {
  if (!existsSync(stateFilePath)) return
  try {
    const raw = await readFile(stateFilePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>

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

    app.log.info({ file: stateFilePath }, "Loaded persisted orchestrator state")
  } catch (error) {
    app.log.error({ err: toErrorDetail(error), file: stateFilePath }, "Failed to load persisted orchestrator state")
  }
}

function getRecentEdits(session: string, slug: string) {
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

function clarificationSuggestions(args: { body: ChatRequestBody; current: PageDoc; selected?: PageDoc["blocks"][number] | null }) {
  const { selected } = args
  if (selected) {
    const keys = editablePropsFromBlock(selected)
    if (keys.length > 0) return keys.slice(0, 4).map(promptFromPropKey)
    return [
      `Update ${selected.type} title to "..."`,
      `Move ${selected.type} to bottom`,
      `Remove selected block`
    ]
  }
  return [
    "Change heading to \"...\"",
    "Add Testimonials below Hero",
    "Move FAQ to bottom",
    "Remove selected block"
  ]
}

function demoPlanFromMessage(message: string, slug: string, activeBlockId?: string, activeBlockType?: string): EditPlan {
  const lower = message.toLowerCase()
  const quoted = /"([^"]+)"/.exec(message)?.[1]

  if (lower.includes("make this shorter") && activeBlockId && activeBlockType === "Hero") {
    return {
      intent: "edit_plan",
      summary_for_user: "Shortened the selected hero copy.",
      change_log: ["Updated hero heading and subheading to be more concise."],
      ops: [
        {
          op: "update_props",
          pageSlug: slug,
          blockId: activeBlockId,
          patch: {
            heading: "Edit your site in seconds",
            subheading: "Describe a change and preview it instantly."
          }
        }
      ]
    }
  }

  if ((lower.includes("title") || lower.includes("heading")) && activeBlockId && activeBlockType === "Hero") {
    const headingText =
      quoted ??
      message
        .replace(/change/i, "")
        .replace(/hero/i, "")
        .replace(/title/i, "")
        .replace(/heading/i, "")
        .replace(/\bto\b/i, "")
        .trim()

    if (headingText) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the hero title.",
        change_log: [`Changed hero heading to "${headingText}".`],
        ops: [
          {
            op: "update_props",
            pageSlug: slug,
            blockId: activeBlockId,
            patch: { heading: headingText }
          }
        ]
      }
    }
  }

  if (lower.includes("rich text") || lower.includes("richtext") || lower.includes("text block") || lower.includes("prose")) {
    if (lower.includes("add") || lower.includes("insert") || lower.includes("create")) {
      return {
        intent: "edit_plan",
        summary_for_user: "Added a rich text section.",
        change_log: ["Inserted RichText block."],
        ops: [
          {
            op: "add_block",
            pageSlug: slug,
            block: {
              id: `b_richtext_${Date.now()}`,
              type: "RichText",
              props: {
                title: "",
                body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
              }
            }
          }
        ]
      }
    }
    if (activeBlockId && activeBlockType === "RichText" && quoted) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the rich text body.",
        change_log: [`Set body to "${quoted}".`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: activeBlockId, patch: { body: quoted } }]
      }
    }
  }

  if (lower.includes("add testimonials")) {
    return {
      intent: "edit_plan",
      summary_for_user: "Added a testimonials section below the hero.",
      change_log: ["Inserted Testimonials block after the hero section."],
      ops: [
        {
          op: "add_block",
          pageSlug: slug,
          afterBlockId: "b_hero_home",
          block: {
            id: `b_testimonials_${Date.now()}`,
            type: "Testimonials",
            props: {
              title: "Loved by small teams",
              items: [
                { quote: "We launched in a day.", author: "Ana, Founder" },
                { quote: "Edits are now effortless.", author: "Chris, Marketer" }
              ]
            }
          }
        }
      ]
    }
  }

  if (lower.includes("remove") && activeBlockId) {
    return {
      intent: "edit_plan",
      summary_for_user: "Removed the selected block.",
      change_log: ["Deleted selected section from the page."],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: activeBlockId }]
    }
  }

  return {
    intent: "needs_clarification",
    summary_for_user: "I need one clarification: what section should I change and what exactly should be updated?",
    change_log: [],
    ops: []
  }
}

function extractJsonObject(input: string) {
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return input.slice(start, end + 1)
}

function normalizeOpName(op: unknown) {
  if (typeof op !== "string") return op
  const key = op.toLowerCase().replace(/[\s-]/g, "_")
  const aliases: Record<string, Operation["op"]> = {
    create: "create_page",
    create_page: "create_page",
    createpage: "create_page",
    add: "add_block",
    add_block: "add_block",
    addblock: "add_block",
    insert_block: "add_block",
    insertblock: "add_block",
    update: "update_props",
    update_props: "update_props",
    updateprops: "update_props",
    update_block: "update_props",
    updateblock: "update_props",
    edit_block: "update_props",
    editblock: "update_props",
    remove: "remove_block",
    remove_block: "remove_block",
    removeblock: "remove_block",
    delete: "remove_block",
    delete_block: "remove_block",
    deleteblock: "remove_block",
    move: "move_block",
    move_block: "move_block",
    moveblock: "move_block",
    reorder_block: "move_block",
    reorderblock: "move_block",
    duplicate_block: "duplicate_block",
    duplicateblock: "duplicate_block",
    copy_block: "duplicate_block",
    copyblock: "duplicate_block",
    clone_block: "duplicate_block",
    cloneblock: "duplicate_block",
    move_page: "move_page",
    movepage: "move_page",
    reorder_page: "move_page",
    reorderpage: "move_page",
    duplicate_page: "duplicate_page",
    duplicatepage: "duplicate_page",
    copy_page: "duplicate_page",
    copypage: "duplicate_page",
    clone_page: "duplicate_page",
    clonepage: "duplicate_page",
    rename: "rename_page",
    rename_page: "rename_page",
    renamepage: "rename_page",
    remove_page: "remove_page",
    removepage: "remove_page",
    delete_page: "remove_page",
    deletepage: "remove_page"
  }
  return aliases[key] ?? op
}

function normalizeRouteCandidate(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null
  const trimmed = candidate.trim()
  if (!trimmed) return null
  if (trimmed === "/") return "/"
  if (trimmed.startsWith("/")) return trimmed
  if (/^[a-z0-9][a-z0-9/_-]*$/i.test(trimmed)) return `/${trimmed}`
  return null
}

function firstRouteMention(message?: string) {
  if (!message) return null
  const match = message.match(/\/[a-z0-9/_-]*/i)
  if (!match) return null
  return normalizeRouteCandidate(match[0])
}

function extractRouteMentions(message?: string) {
  if (!message) return []
  const matches = message.match(/\/[a-z0-9/_-]*/gi) ?? []
  const out: string[] = []
  for (const item of matches) {
    const normalized = normalizeRouteCandidate(item)
    if (!normalized) continue
    if (out.includes(normalized)) continue
    out.push(normalized)
  }
  return out
}

function orderSlugsHomeFirst(slugs: string[]) {
  return slugs.includes("/") ? ["/", ...slugs.filter((route) => route !== "/")] : slugs
}

function isPageRouteRenameRequest(message?: string) {
  if (!message) return false
  const lower = message.toLowerCase()
  const mentionsRoute = lower.includes("slug") || lower.includes("path") || lower.includes("route") || /\/[a-z0-9/_-]*/i.test(message)
  const asksRename =
    lower.includes("rename") ||
    lower.includes("change") ||
    lower.includes("update") ||
    lower.includes("move") ||
    lower.includes("switch")
  const mentionsPage = lower.includes("page") || lower.includes("this page")
  return mentionsRoute && asksRename && mentionsPage
}

function pageIdFromSlug(slug: string) {
  if (slug === "/") return "p_home"
  const core = slug
    .slice(1)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
  return `p_${core || "page"}`
}

function pageTitleFromSlug(slug: string) {
  if (slug === "/") return "Home"
  const text = slug
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .join(" ")
    .trim()
  if (!text) return "Untitled Page"
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function remapRouteReference(value: string, fromSlug: string, toSlug: string) {
  if (!value.startsWith("/")) return value
  if (fromSlug === "/") {
    if (value === "/") return toSlug
    if (value.startsWith("/?") || value.startsWith("/#")) return `${toSlug}${value.slice(1)}`
    return value
  }
  if (value === fromSlug) return toSlug
  if (value.startsWith(`${fromSlug}/`) || value.startsWith(`${fromSlug}?`) || value.startsWith(`${fromSlug}#`)) {
    return `${toSlug}${value.slice(fromSlug.length)}`
  }
  return value
}

function rewriteRouteLinksInValue(input: unknown, fromSlug: string, toSlug: string): { value: unknown; changed: boolean } {
  if (typeof input === "string") {
    const mapped = remapRouteReference(input, fromSlug, toSlug)
    return { value: mapped, changed: mapped !== input }
  }

  if (Array.isArray(input)) {
    let changed = false
    const next = input.map((item) => {
      const mapped = rewriteRouteLinksInValue(item, fromSlug, toSlug)
      if (mapped.changed) changed = true
      return mapped.value
    })
    return { value: changed ? next : input, changed }
  }

  if (!input || typeof input !== "object") return { value: input, changed: false }
  const source = input as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && key.toLowerCase().includes("href")) {
      const mapped = remapRouteReference(value, fromSlug, toSlug)
      if (mapped !== value) changed = true
      next[key] = mapped
      continue
    }
    if (typeof value === "string" && key === "body") {
      const rewritten = value.replace(/\]\((\/[^)\s]+)\)/g, (full, routeCandidate: string) => {
        const mapped = remapRouteReference(routeCandidate, fromSlug, toSlug)
        if (mapped !== routeCandidate) return `](${mapped})`
        return full
      })
      if (rewritten !== value) changed = true
      next[key] = rewritten
      continue
    }
    const mapped = rewriteRouteLinksInValue(value, fromSlug, toSlug)
    if (mapped.changed) changed = true
    next[key] = mapped.value
  }

  return { value: changed ? next : input, changed }
}

function rewriteLinksToRenamedPage(page: PageDoc, fromSlug: string, toSlug: string) {
  let changed = false
  const nextBlocks = page.blocks.map((block) => {
    const mapped = rewriteRouteLinksInValue(block.props, fromSlug, toSlug)
    if (!mapped.changed) return block
    changed = true
    return { ...block, props: mapped.value as Record<string, unknown> }
  })
  if (!changed) return { changed: false, page }
  return { changed: true, page: { ...page, blocks: nextBlocks, updatedAt: new Date().toISOString() } }
}

function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc; userMessage?: string }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : []
  const userMessage = (args?.userMessage ?? "").toLowerCase()
  const requestedRoute = firstRouteMention(args?.userMessage)
  const routeMentions = extractRouteMentions(args?.userMessage)
  const createPageIntent = /\bcreate\b.*\bpage\b|\bnew\s+page\b/.test(userMessage)

  const resolvePageSlug = (candidate: unknown) => {
    const normalized = normalizeRouteCandidate(candidate)
    if (normalized) return normalized

    if (args?.currentPage) {
      if (typeof candidate !== "string") return args?.defaultSlug
      if (candidate === args.currentPage.id) return args.currentPage.slug
      if (candidate.toLowerCase() === "home" && args.currentPage.slug === "/") return "/"
    }

    return args?.defaultSlug
  }

  const beforeToAfter = (beforeId: unknown) => {
    if (!args?.currentPage || typeof beforeId !== "string") return undefined
    const idx = args.currentPage.blocks.findIndex((block) => block.id === beforeId)
    if (idx <= 0) return undefined
    return args.currentPage.blocks[idx - 1]?.id
  }

  let createdPageSlug: string | undefined
  let droppedPageLevelUpdate = false
  const normalizedOps = ops.flatMap((item) => {
    if (!item || typeof item !== "object") return item
    const source = item as Record<string, unknown>
    const raw = { ...source }

    // Accept malformed one-key op objects like { "move_block": { ...fields } }.
    if (!raw.op && !raw.operation && !raw.action && !raw.kind) {
      for (const key of [
        "create_page",
        "add_block",
        "update_props",
        "remove_block",
        "move_block",
        "duplicate_block",
        "rename_page",
        "remove_page",
        "move_page",
        "duplicate_page"
      ] as const) {
        const value = source[key]
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(raw, value as Record<string, unknown>)
          raw.op = key
          break
        }
      }
    }

    raw.op = normalizeOpName(raw.op ?? raw.operation ?? raw.action ?? raw.kind)
    const rawType =
      raw.type ?? raw.blockType ?? raw.block_type ?? raw.newBlockType ?? raw.new_block_type ?? raw.target_block_type ?? raw.targetBlockType
    const normalizedType =
      typeof rawType === "string"
        ? allowedBlockTypes.find((type) => type.toLowerCase() === rawType.toLowerCase()) ?? inferBlockTypeFromText(rawType)
        : undefined

    raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.page_slug ?? raw.slug ?? raw.page ?? raw.path ?? raw.route ?? raw.from)
    raw.newPageSlug = normalizeRouteCandidate(
      raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
    )
    if (!raw.blockId) {
      const pathCandidate = typeof raw.path === "string" && raw.path.startsWith("b_") ? raw.path : undefined
      raw.blockId =
        raw.block_id ?? raw.targetBlockId ?? raw.target_block_id ?? raw.sourceBlockId ?? raw.source_block_id ?? raw.id ?? pathCandidate
    }
    if (!raw.newBlockId) {
      raw.newBlockId = raw.new_block_id ?? raw.targetBlockId ?? raw.target_block_id ?? raw.copiedBlockId ?? raw.copied_block_id
    }
    if (!raw.afterBlockId) {
      raw.afterBlockId =
        raw.after_block_id ?? raw.after ?? raw.insertAfterId ?? beforeToAfter(raw.beforeId ?? raw.insertBeforeId)
    }
    if (!raw.afterPageSlug) {
      raw.afterPageSlug =
        raw.afterPageSlug ??
        raw.after_page_slug ??
        raw.afterPage ??
        raw.after_page ??
        raw.anchorPageSlug ??
        raw.anchor_page_slug ??
        raw.after
    }
    raw.afterPageSlug = resolvePageSlug(raw.afterPageSlug)
    raw.beforePageSlug = resolvePageSlug(raw.beforePageSlug ?? raw.before_page_slug ?? raw.beforePage ?? raw.before_page)
    if (!raw.patch) {
      raw.patch = raw.props ?? raw.changes
    }

    if (
      raw.op === "update_props" &&
      (!raw.blockId || typeof raw.blockId !== "string") &&
      args?.defaultSlug
    ) {
      const patch = patchObject(raw.patch)
      const newSlugFromPatch = normalizeRouteCandidate(patch?.slug ?? patch?.path ?? patch?.route)
      const newSlugFromPath = typeof raw.path === "string" && raw.path.startsWith("/") ? normalizeRouteCandidate(raw.path) : null
      const fromSlugFromMentions = routeMentions[0]
      const toSlugFromMentions = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
      const nextSlug = raw.newPageSlug ?? newSlugFromPatch ?? newSlugFromPath ?? toSlugFromMentions
      const fromSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? fromSlugFromMentions)
      if (fromSlug && nextSlug && fromSlug !== nextSlug) {
        raw.op = "rename_page"
        raw.pageSlug = fromSlug
        raw.newPageSlug = nextSlug
        delete raw.patch
      }
    }

    if (raw.op === "remove_block" && (!raw.blockId || typeof raw.blockId !== "string")) {
      const asksDeletePage = /\b(delete|remove)\b.*\bpage\b/.test(userMessage)
      if (asksDeletePage) {
        raw.op = "remove_page"
        raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      }
    }

    if (raw.op === "rename_page") {
      const nextSlug =
        raw.newPageSlug ??
        normalizeRouteCandidate(raw.path) ??
        normalizeRouteCandidate(raw.route) ??
        normalizeRouteCandidate(raw.slug) ??
        (routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined)
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? routeMentions[0])
      raw.newPageSlug = nextSlug
      if (!raw.newTitle && typeof raw.title === "string" && raw.title.trim().length > 0) raw.newTitle = raw.title.trim()
      if (
        typeof raw.pageSlug === "string" &&
        typeof raw.newPageSlug === "string" &&
        raw.pageSlug === raw.newPageSlug
      ) {
        return null
      }
    }

    if (raw.op === "remove_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
    }

    if (raw.op === "move_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      if (!raw.afterPageSlug && raw.beforePageSlug && args?.currentPage) {
        if (raw.beforePageSlug === "/") raw.afterPageSlug = undefined
        else if (raw.beforePageSlug === args.currentPage.slug) raw.afterPageSlug = undefined
      }
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }

    if (raw.op === "duplicate_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? raw.from ?? routeMentions[0] ?? args?.defaultSlug)
      raw.newPageSlug = normalizeRouteCandidate(
        raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
      )
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }
    if (!raw.block) {
      raw.block = raw.newBlock ?? raw.new_block
      if (!raw.block && (raw.op === "add_block" || raw.op === "create_page") && normalizedType) {
        const generatedId =
          typeof raw.blockId === "string" && raw.blockId.length > 0
            ? raw.blockId
            : args?.currentPage
              ? nextBlockId(normalizedType, args.currentPage)
              : `b_${String(normalizedType).toLowerCase()}_${Date.now()}`
        const incomingPatch = patchObject(raw.props ?? raw.patch ?? raw.changes) ?? {}
        raw.block = {
          id: generatedId,
          type: normalizedType,
          props: { ...defaultPropsForType(normalizedType), ...incomingPatch }
        }
      }
    }
    if (raw.op === "add_block" && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
      const block = raw.block as Record<string, unknown>
      if ((!block.type || typeof block.type !== "string") && normalizedType) block.type = normalizedType
      if ((!block.props || typeof block.props !== "object" || Array.isArray(block.props)) && (raw.patch || raw.props || raw.changes)) {
        block.props = patchObject(raw.patch ?? raw.props ?? raw.changes) ?? {}
      }
      if ((!block.id || typeof block.id !== "string") && typeof block.type === "string") {
        block.id = `b_${String(block.type).toLowerCase()}_${Date.now()}`
      }
      raw.block = block
    }

    const createSlugCandidate = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? requestedRoute)
    const explicitCreateTarget = createSlugCandidate && createSlugCandidate !== args?.defaultSlug

    // LLMs sometimes emit create_page when they actually mean add_block.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      !explicitCreateTarget &&
      (raw.block || normalizedType || raw.blockId || raw.patch || raw.props)
    ) {
      raw.op = "add_block"
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug)
    }

    // LLMs also emit create_page with blocks[] for existing pages. Convert to add_block sequence.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      Array.isArray(raw.blocks) &&
      raw.blocks.length > 0
    ) {
      const pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug) ?? args?.defaultSlug
      if (!pageSlug) return raw
      const out: Record<string, unknown>[] = []
      let previousId: string | undefined
      for (const candidate of raw.blocks) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
        const block = { ...(candidate as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : ""
        const blockType =
          allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
        if (!blockType) continue
        if (typeof block.id !== "string" || block.id.length === 0) {
          block.id = args?.currentPage ? nextBlockId(blockType, args.currentPage) : `b_${blockType.toLowerCase()}_${Date.now()}`
        }
        if (!block.props || typeof block.props !== "object" || Array.isArray(block.props)) {
          block.props = defaultPropsForType(blockType)
        }
        const addOp: Record<string, unknown> = {
          op: "add_block",
          pageSlug,
          block
        }
        if (previousId) addOp.afterBlockId = previousId
        previousId = block.id as string
        out.push(addOp)
      }
      return out.length > 0 ? out : raw
    }

    // Accept lightweight or partial create_page operations and synthesize a valid PageDoc payload.
    if (raw.op === "create_page") {
      const pageInput =
        raw.page && typeof raw.page === "object" && !Array.isArray(raw.page) ? (raw.page as Record<string, unknown>) : {}
      const pageSlugInput =
        pageInput.slug ?? raw.pageSlug ?? raw.page_slug ?? raw.path ?? raw.slug ?? raw.route ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const slug = resolvePageSlug(pageSlugInput) ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const nowIso = new Date().toISOString()
      const blocks: PageDoc["blocks"] = []

      if (Array.isArray(pageInput.blocks)) {
        for (const candidate of pageInput.blocks) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
          const block = candidate as Record<string, unknown>
          const typeRaw = typeof block.type === "string" ? block.type : ""
          const blockType =
            allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
          if (!blockType) continue
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }

      if (blocks.length === 0 && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
        const block = { ...(raw.block as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : normalizedType
        const blockType =
          typeof typeRaw === "string"
            ? allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
            : undefined
        if (blockType) {
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }

      raw.page = {
        id: typeof pageInput.id === "string" && pageInput.id.trim().length > 0 ? pageInput.id.trim() : pageIdFromSlug(slug),
        slug,
        title:
          typeof pageInput.title === "string" && pageInput.title.trim().length > 0 ? pageInput.title.trim() : pageTitleFromSlug(slug),
        updatedAt:
          typeof pageInput.updatedAt === "string" && pageInput.updatedAt.trim().length > 0 ? pageInput.updatedAt.trim() : nowIso,
        blocks
      } satisfies PageDoc
      raw.pageSlug = slug
      createdPageSlug = slug
    }

    // If model mixes create_page + add_block and keeps add_block on the current route, move it to the new route.
    if (raw.op === "add_block" && createPageIntent && createdPageSlug && raw.pageSlug === args?.defaultSlug) {
      raw.pageSlug = createdPageSlug
    }

    // Intent repair: if user asked for bottom/end and model omitted an anchor, place at end.
    if (
      (raw.op === "move_block" || raw.op === "add_block") &&
      !raw.afterBlockId &&
      args?.currentPage &&
      (userMessage.includes("bottom") || userMessage.includes("end") || userMessage.includes("last"))
    ) {
      const movingId =
        typeof raw.blockId === "string"
          ? raw.blockId
          : raw.op === "add_block" && raw.block && typeof raw.block === "object" && typeof (raw.block as { id?: unknown }).id === "string"
            ? (raw.block as { id: string }).id
            : undefined
      const tail = [...args.currentPage.blocks].reverse().find((b) => b.id !== movingId)
      if (tail) raw.afterBlockId = tail.id
    }

    return raw
  })

  const sanitizedOps = normalizedOps.filter((item) => {
    if (!item) return false
    if (typeof item !== "object" || Array.isArray(item)) return true
    const raw = item as Record<string, unknown>
    if (normalizeOpName(raw.op) !== "update_props") return true
    if (typeof raw.blockId === "string" && raw.blockId.length > 0) return true
    const patch = patchObject(raw.patch)
    const hasPageLevelPatch =
      !!patch &&
      (typeof patch.slug === "string" || typeof patch.path === "string" || typeof patch.route === "string" || typeof patch.title === "string")
    const pathLooksLikeRoute = typeof raw.path === "string" && raw.path.startsWith("/")
    if (hasPageLevelPatch || pathLooksLikeRoute) {
      droppedPageLevelUpdate = true
      return false
    }
    return false
  })

  if (droppedPageLevelUpdate && sanitizedOps.length === 0) {
    return {
      ...root,
      intent: "needs_clarification",
      summary_for_user: "I could not infer a valid page operation. Specify the source and target routes explicitly.",
      change_log: [
        "Ignored an invalid page-level update_props operation that was missing blockId.",
        "Try: rename page from /old to /new, or delete page /path."
      ],
      ops: []
    }
  }

  return { ...root, ops: sanitizedOps }
}

function blockContractsSummary() {
  return {
    Hero: {
      allowedProps: ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt", "secondaryCtaText", "secondaryCtaHref"],
      required: ["heading", "subheading", "ctaText", "ctaHref"],
      optional: ["imageUrl", "imageAlt", "secondaryCtaText", "secondaryCtaHref"],
      notes: "Use heading for the main headline; never invent prop names. For imageUrl: when the user asks to generate, change, or update the hero image, use https://picsum.photos/seed/{keyword}/1600/900 where {keyword} is 1–2 lowercase hyphenated words derived from the heading content (e.g. heading 'Build AI Websites' → seed 'ai-websites'). Always update imageAlt to describe what the image represents. Do not invent other image URLs. secondaryCtaText/secondaryCtaHref are optional: set them to add a ghost/outline secondary button beside the primary CTA; omit or set to empty string to hide it."
    },
    FeatureGrid: {
      allowedProps: ["title", "features"],
      required: ["title", "features"],
      notes: "features must be a non-empty array of {title, description}."
    },
    Testimonials: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {quote, author}."
    },
    FAQAccordion: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {q, a}."
    },
    CTA: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "Keep existing props unless the user asks to change them."
    },
    Card: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "A standalone card with one CTA."
    },
    CardGrid: {
      allowedProps: ["title", "cards"],
      required: ["title", "cards"],
      notes: "cards must be a non-empty array of {title, description, ctaText, ctaHref}."
    },
    RichText: {
      allowedProps: ["title", "body"],
      required: ["body"],
      optional: ["title"],
      notes: "body is a string; use \\n\\n to separate paragraphs. Supported inline syntax: **word** for bold, *word* for italic, [text](url) for links, '# Heading' lines become h3 headings. title is an optional section heading. Never invent prop names."
    }
  }
}

function readPathValue(root: unknown, path: string) {
  if (!path) return undefined
  const parts: Array<string | number> = []
  const regex = /([^[.\]]+)|\[(\d+)\]/g
  for (const match of path.matchAll(regex)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  let current: unknown = root
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string }) {
  if (!args.activeBlockId) return null
  const block = args.currentPage.blocks.find((item) => item.id === args.activeBlockId)
  if (!block) return null
  const editablePath = typeof args.activeEditablePath === "string" && args.activeEditablePath.length > 0 ? args.activeEditablePath : null
  return {
    id: block.id,
    type: block.type,
    props: block.props,
    selectedEditablePath: editablePath,
    selectedEditableValue: editablePath ? readPathValue(block.props, editablePath) ?? null : null
  }
}

const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])
const intentSchema = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().min(1).optional(),
  target_block_type: blockTypeEnum.optional(),
  new_block_type: blockTypeEnum.optional(),
  position: z.enum(["top", "bottom", "before", "after"]).optional(),
  anchor_block_ref: z.string().min(1).optional(),
  patch: z.record(z.unknown()).optional(),
  summary: z.string().min(1).optional(),
  assumption: z.string().min(1).optional()
})
type ParsedIntent = z.infer<typeof intentSchema>

function inferBlockTypeFromText(text: string): BlockType | undefined {
  const normalized = text.toLowerCase()
  if (normalized.includes("hero")) return "Hero"
  if (normalized.includes("featuregrid") || normalized.includes("feature grid") || normalized.includes("features")) return "FeatureGrid"
  if (normalized.includes("testimonial")) return "Testimonials"
  if (normalized.includes("faq")) return "FAQAccordion"
  if (normalized.includes("cta")) return "CTA"
  if (normalized.includes("cardgrid") || normalized.includes("card grid")) return "CardGrid"
  if (normalized.includes("card")) return "Card"
  if (normalized.includes("richtext") || normalized.includes("rich text") || normalized.includes("rich-text") || normalized.includes("prose") || normalized.includes("text block")) return "RichText"
  return undefined
}

function inferAddedBlockTypeFromMessage(message: string): BlockType | undefined {
  const normalized = message.toLowerCase()
  const addMatch = normalized.match(/\b(add|create|insert)\b\s+(?:a|an)?\s*([a-z -]+)/)
  if (!addMatch?.[2]) return undefined
  const chunk = addMatch[2].trim()
  if (chunk.startsWith("card grid") || chunk.startsWith("cardgrid")) return "CardGrid"
  if (chunk.startsWith("card")) return "Card"
  if (chunk.startsWith("feature grid") || chunk.startsWith("featuregrid") || chunk.startsWith("features")) return "FeatureGrid"
  if (chunk.startsWith("testimonial")) return "Testimonials"
  if (chunk.startsWith("faq")) return "FAQAccordion"
  if (chunk.startsWith("cta")) return "CTA"
  if (chunk.startsWith("hero")) return "Hero"
  if (chunk.startsWith("rich text") || chunk.startsWith("richtext") || chunk.startsWith("rich-text") || chunk.startsWith("prose") || chunk.startsWith("text block")) return "RichText"
  return undefined
}

function resolveBlockRef(args: {
  ref?: string
  currentPage: PageDoc
  activeBlockId?: string
  fallbackType?: BlockType
}): PageDoc["blocks"][number] | null {
  const { ref, currentPage, activeBlockId, fallbackType } = args
  const blocks = currentPage.blocks
  if (typeof ref === "string" && ref.length > 0) {
    const exact = blocks.find((b) => b.id === ref)
    if (exact) return exact
    const key = ref.toLowerCase().replace(/[\s_-]/g, "")
    if (["selected", "active", "current", "this"].includes(key) && activeBlockId) {
      const selected = blocks.find((b) => b.id === activeBlockId)
      if (selected) return selected
    }
    const byType = inferBlockTypeFromText(key)
    if (byType) {
      const found = blocks.find((b) => b.type === byType)
      if (found) return found
    }
    const contains = blocks.find((b) => b.id.toLowerCase().includes(key))
    if (contains) return contains
  }

  if (activeBlockId) {
    const selected = blocks.find((b) => b.id === activeBlockId)
    if (selected) return selected
  }
  if (fallbackType) {
    const found = blocks.find((b) => b.type === fallbackType)
    if (found) return found
  }
  return null
}

function ordinalToIndex(value: string) {
  const key = value.toLowerCase()
  if (key === "first" || key === "1st") return 0
  if (key === "second" || key === "2nd") return 1
  if (key === "third" || key === "3rd") return 2
  if (key === "fourth" || key === "4th") return 3
  if (key === "fifth" || key === "5th") return 4
  if (key === "last") return -1
  return null
}

function resolveByDescriptor(args: { descriptor: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { descriptor, currentPage, activeBlockId } = args
  const normalized = descriptor.trim().toLowerCase()
  if (!normalized) return null
  if (["this", "this block", "this section", "selected", "selected block", "current block"].includes(normalized)) {
    if (!activeBlockId) return null
    return currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
  }

  const exact = currentPage.blocks.find((b) => b.id.toLowerCase() === normalized)
  if (exact) return exact

  const type = inferBlockTypeFromText(normalized)
  if (!type) return null
  const typed = currentPage.blocks.filter((b) => b.type === type)
  if (typed.length === 0) return null

  const ord = normalized.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/)?.[1]
  const idx = ord ? ordinalToIndex(ord) : 0
  if (idx === null) return typed[0]
  if (idx === -1) return typed[typed.length - 1]
  return typed[idx] ?? typed[0]
}

function resolveReferencesFromMessage(args: { message: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { message, currentPage, activeBlockId } = args
  const lower = message.toLowerCase()

  const mentioned = new Map<string, { id: string; type: BlockType; reason: string }>()
  const addMention = (block: PageDoc["blocks"][number] | null, reason: string) => {
    if (!block) return
    if (!mentioned.has(block.id)) mentioned.set(block.id, { id: block.id, type: block.type, reason })
  }

  if (activeBlockId) {
    const selected = currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
    addMention(selected, "active_selection")
  }

  const descriptorMatches = lower.match(
    /\b(first|second|third|fourth|fifth|last)?\s*(hero|feature grid|features|testimonials?|faq|cta|card grid|card)s?\b/g
  )
  for (const match of descriptorMatches ?? []) {
    addMention(resolveByDescriptor({ descriptor: match, currentPage, activeBlockId }), "descriptor_match")
  }

  for (const block of currentPage.blocks) {
    if (lower.includes(block.id.toLowerCase())) addMention(block, "id_match")
  }

  const afterDescriptor = lower.match(/\b(?:after|below|under)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const beforeDescriptor = lower.match(/\b(?:before|above)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const primaryDescriptor = lower.match(/\b(?:update|change|edit|remove|delete|move)\s+([a-z0-9_\-\s]+?)(?:\b(?:to|into|with|after|before|above|below|under)\b|[,.]|$)/)?.[1]?.trim()

  const anchor = resolveByDescriptor({
    descriptor: afterDescriptor ?? beforeDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  const target = resolveByDescriptor({
    descriptor: primaryDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  addMention(anchor, "anchor_match")
  addMention(target, "target_match")

  return {
    target: target ? { id: target.id, type: target.type } : null,
    anchor: anchor ? { id: anchor.id, type: anchor.type } : null,
    mentionedBlocks: Array.from(mentioned.values()).slice(0, 8)
  }
}

function arrayPropLengths(props: Record<string, unknown>) {
  const out: Record<string, { length: number }> = {}
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) out[key] = { length: value.length }
  }
  return out
}

function pageIntentSummary(args: { slug: string; currentPage: PageDoc }) {
  const { slug, currentPage } = args
  const typeCounts = new Map<string, number>()
  for (const block of currentPage.blocks) {
    typeCounts.set(block.type, (typeCounts.get(block.type) ?? 0) + 1)
  }
  const composition = Array.from(typeCounts.entries())
    .map(([type, count]) => (count > 1 ? `${type} x${count}` : type))
    .join(", ")
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  const heroHeading = hero && typeof (hero.props as Record<string, unknown>).heading === "string" ? (hero.props as { heading: string }).heading : ""
  const routeLabel = slug === "/" ? "Home page" : `Page ${slug}`
  const headingPart = heroHeading ? ` Hero message: "${heroHeading}".` : ""
  return `${routeLabel} with ${currentPage.blocks.length} blocks (${composition}).${headingPart}`
}

function plannerContextPack(args: {
  session: string
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}) {
  const { session, slug, message, currentPage, activeBlockId, activeBlockType, activeEditablePath } = args
  const pageRoutes = orderSlugsHomeFirst(Array.from(getSessionDraft(session).keys()))
  const selectedIdx = activeBlockId ? currentPage.blocks.findIndex((b) => b.id === activeBlockId) : -1
  const neighbors =
    selectedIdx >= 0
      ? {
          previous: selectedIdx > 0 ? currentPage.blocks[selectedIdx - 1] : null,
          next: selectedIdx < currentPage.blocks.length - 1 ? currentPage.blocks[selectedIdx + 1] : null
        }
      : { previous: null, next: null }

  return {
    route: slug,
    pageRoutes,
    blockCount: currentPage.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockType ?? null,
      editablePath: activeEditablePath ?? null,
      block: selectedBlockSnapshot({ currentPage, activeBlockId, activeEditablePath })
    },
    neighbors: {
      previous: neighbors.previous ? { id: neighbors.previous.id, type: neighbors.previous.type } : null,
      next: neighbors.next ? { id: neighbors.next.id, type: neighbors.next.type } : null
    },
    pageOutline: currentPage.blocks.map((b) => {
      const bProps = b.props as Record<string, unknown>
      const arrProps = arrayPropLengths(bProps)
      // Selected block: send full props for precise editing context
      if (b.id === activeBlockId) {
        return { id: b.id, type: b.type, props: structuredClone(bProps), arrayProps: arrProps }
      }
      // Other blocks: scalar props only — keeps token count low
      const scalarProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(bProps)) {
        if (!Array.isArray(value) && (typeof value !== "object" || value === null)) {
          scalarProps[key] = value
        }
      }
      return { id: b.id, type: b.type, props: scalarProps, arrayProps: arrProps }
    }),
    pageIntent: pageIntentSummary({ slug, currentPage }),
    recentSuccessfulEdits: getRecentEdits(session, slug),
    resolvedReferences: resolveReferencesFromMessage({ message, currentPage, activeBlockId })
  }
}

function nextBlockId(type: BlockType, page: PageDoc) {
  const base = `b_${type.toLowerCase()}_${Date.now()}`
  if (!page.blocks.some((b) => b.id === base)) return base
  let i = 1
  while (page.blocks.some((b) => b.id === `${base}_${i}`)) i += 1
  return `${base}_${i}`
}

function defaultPropsForType(type: BlockType) {
  if (type === "Hero") {
    return {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Abstract generated illustration"
    }
  }
  if (type === "FeatureGrid") {
    return {
      title: "Key features",
      features: [
        { title: "Fast setup", description: "Launch quickly with guided defaults." },
        { title: "Safe edits", description: "Structured operations keep content valid." },
        { title: "Live updates", description: "Preview changes immediately." }
      ]
    }
  }
  if (type === "Testimonials") {
    return {
      title: "What customers say",
      items: [
        { quote: "We launched faster than expected.", author: "Alex" },
        { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
      ]
    }
  }
  if (type === "FAQAccordion") {
    return {
      title: "Frequently asked questions",
      items: [
        { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
        { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
      ]
    }
  }
  if (type === "Card") {
    return {
      title: "Launch faster",
      description: "Go from idea to published changes in minutes.",
      ctaText: "Learn more",
      ctaHref: "/pricing"
    }
  }
  if (type === "RichText") {
    return {
      title: "",
      body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
    }
  }
  if (type === "CardGrid") {
    return {
      title: "Explore more",
      cards: [
        {
          title: "Fast setup",
          description: "Create and ship updates quickly.",
          ctaText: "Get started",
          ctaHref: "/"
        },
        {
          title: "Safe updates",
          description: "Schema-validated edits reduce breakage.",
          ctaText: "See how",
          ctaHref: "/pricing"
        },
        {
          title: "Team workflow",
          description: "Collaborate with clear, reviewable changes.",
          ctaText: "Read guide",
          ctaHref: "/"
        }
      ]
    }
  }
  return {
    title: "Ready to get started?",
    description: "Apply your next change in seconds.",
    ctaText: "Start now",
    ctaHref: "/"
  }
}

function coercePatchForBlock(block: PageDoc["blocks"][number], rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return {}
  const source =
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
      ? ((rawPatch as { props: Record<string, unknown> }).props as Record<string, unknown>)
      : (rawPatch as Record<string, unknown>)

  const allowed = Object.keys(block.props as Record<string, unknown>)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowed) normalizedToAllowed.set(key.toLowerCase(), key)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    const mapped = normalizedToAllowed.get(key.toLowerCase())
    if (mapped) out[mapped] = value
  }
  return out
}

function patchObject(rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null
  if (
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
  ) {
    return (rawPatch as { props: Record<string, unknown> }).props
  }
  return rawPatch as Record<string, unknown>
}

function parseIndexedPath(path: string) {
  const match = /^([a-zA-Z0-9_]+)\[(\d+)\](?:\.(.+))?$/.exec(path.trim())
  if (!match) return null
  return {
    listKey: match[1],
    index: Number(match[2]),
    leaf: match[3]
  }
}

function inferSimpleFieldPatchFromMessage(message: string) {
  const m = message
    .replace(/[“”]/g, '"')
    .match(/\b(?:change|set|update|edit)\b[\s\w]*?\b(title|description|cta\s*text|cta|link|href|quote|author|question|answer|q|a)\b[\s\w]*?\b(?:to|as)\b\s+"?([^"\n]+)"?/i)
  if (!m) return null
  const rawField = m[1].toLowerCase().replace(/\s+/g, "")
  const value = m[2]?.trim()
  if (!value) return null
  const map: Record<string, string> = {
    title: "title",
    description: "description",
    ctatext: "ctaText",
    cta: "ctaText",
    link: "ctaHref",
    href: "ctaHref",
    quote: "quote",
    author: "author",
    question: "q",
    answer: "a",
    q: "q",
    a: "a"
  }
  const key = map[rawField]
  if (!key) return null
  return { [key]: value } as Record<string, unknown>
}

function isRewriteRequest(message: string) {
  const lower = message.toLowerCase()
  return (
    lower.includes("rewrite") ||
    lower.includes("reword") ||
    lower.includes("improve") ||
    lower.includes("simplif") ||
    lower.includes("make this shorter") ||
    lower.includes("shorten")
  )
}

function inferFieldHintFromMessage(message: string, allowedKeys: string[]) {
  const lower = message.toLowerCase()
  const keyMap: Array<{ test: RegExp; key: string }> = [
    { test: /\btitle\b|\bheading\b/, key: "title" },
    { test: /\bdescription\b|\bbody\b|\bcopy\b/, key: "description" },
    { test: /\bcta\s*text\b|\bbutton\s*text\b/, key: "ctaText" },
    { test: /\bcta\s*link\b|\bhref\b|\blink\b|\burl\b/, key: "ctaHref" },
    { test: /\bquote\b/, key: "quote" },
    { test: /\bauthor\b/, key: "author" },
    { test: /\bquestion\b|\bfaq\s*q\b/, key: "q" },
    { test: /\banswer\b|\bfaq\s*a\b/, key: "a" }
  ]

  for (const entry of keyMap) {
    if (entry.test.test(lower) && allowedKeys.includes(entry.key)) return entry.key
  }
  return allowedKeys[0]
}

function rewriteFromExisting(existing: string, message: string) {
  let next = existing
    .replace(/\bamazing\b/gi, "great")
    .replace(/\bincredible\b/gi, "powerful")
    .replace(/\breally\b/gi, "")
    .replace(/\bvery\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  if (/short|shorter|concise|brief/i.test(message)) {
    const sentence = next.split(/[.!?]/)[0]?.trim()
    if (sentence) next = sentence.endsWith(".") ? sentence : `${sentence}.`
  }

  if (next === existing) {
    next = existing.endsWith(".") ? `${existing.slice(0, -1)} today.` : `${existing} today.`
  }
  return next
}

function coercePatchForEditablePath(block: PageDoc["blocks"][number], editablePath: string | undefined, rawPatch: unknown, message: string) {
  if (!editablePath) return null
  const directKey = editablePath.trim()
  const blockProps = block.props as Record<string, unknown>
  if (directKey && Object.prototype.hasOwnProperty.call(blockProps, directKey)) {
    const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
    let value: unknown

    if (source) {
      if (Object.prototype.hasOwnProperty.call(source, directKey)) value = source[directKey]
      else {
        const mapped = Object.keys(source).find((key) => key.toLowerCase() === directKey.toLowerCase())
        if (mapped) value = source[mapped]
      }
    }

    if (value === undefined) {
      const quoted = quotedText(message)
      if (quoted) value = quoted
    }
    if (value === undefined && isRewriteRequest(message)) {
      const existing = blockProps[directKey]
      if (typeof existing === "string" && existing.trim().length > 0) value = rewriteFromExisting(existing, message)
    }
    if (value === undefined) return null

    return {
      patch: { [directKey]: value } as Record<string, unknown>,
      changedKeys: [directKey],
      rootKey: directKey
    }
  }

  const parsed = parseIndexedPath(editablePath)
  if (!parsed) return null

  const list = (block.props as Record<string, unknown>)[parsed.listKey]
  if (!Array.isArray(list) || parsed.index < 0 || parsed.index >= list.length) return null
  const rowRaw = list[parsed.index]
  if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return null
  const row = rowRaw as Record<string, unknown>

  const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)

  const allowedItemKeys = Object.keys(row)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowedItemKeys) normalizedToAllowed.set(key.toLowerCase(), key)

  const itemPatch: Record<string, unknown> = {}
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.trim()
      const fromPathPrefix = `${parsed.listKey}[${parsed.index}].`
      const childKey = normalized.startsWith(fromPathPrefix) ? normalized.slice(fromPathPrefix.length) : normalized
      const mapped = normalizedToAllowed.get(childKey.toLowerCase())
      if (mapped) itemPatch[mapped] = value
    }
  }

  if (Object.keys(itemPatch).length === 0 && isRewriteRequest(message)) {
    const preferredKey =
      (parsed.leaf && normalizedToAllowed.get(parsed.leaf.toLowerCase())) ?? inferFieldHintFromMessage(message, allowedItemKeys)
    if (preferredKey) {
      const existing = row[preferredKey]
      if (typeof existing === "string" && existing.trim().length > 0) {
        itemPatch[preferredKey] = rewriteFromExisting(existing, message)
      }
    }
  }
  if (Object.keys(itemPatch).length === 0) return null

  const nextList = list.map((entry, idx) => {
    if (idx !== parsed.index || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return { ...(entry as Record<string, unknown>), ...itemPatch }
  })
  return {
    patch: { [parsed.listKey]: nextList } as Record<string, unknown>,
    changedKeys: Object.keys(itemPatch),
    rootKey: parsed.listKey
  }
}

function quotedText(message: string) {
  return /"([^"]+)"/.exec(message)?.[1]?.trim()
}

function buildListAppendPatch(block: PageDoc["blocks"][number], message: string) {
  const lower = message.toLowerCase()
  const quoted = quotedText(message)

  if (block.type === "FAQAccordion") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const q = quoted ?? (lower.includes("question") ? "New question" : "How does this work?")
    const next = [...existing, { q, a: "Add answer here." }]
    return { items: next }
  }

  if (block.type === "Testimonials") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const quote = quoted ?? "Great experience."
    const next = [...existing, { quote, author: "Customer" }]
    return { items: next }
  }

  if (block.type === "FeatureGrid") {
    const existing = Array.isArray(block.props.features) ? (block.props.features as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New feature"
    const next = [...existing, { title, description: "Describe this feature." }]
    return { features: next }
  }

  if (block.type === "CardGrid") {
    const existing = Array.isArray(block.props.cards) ? (block.props.cards as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New card"
    const next = [...existing, { title, description: "Add card description.", ctaText: "Learn more", ctaHref: "/" }]
    return { cards: next }
  }

  return null
}

function compileDeterministicPlan(args: {
  session: string
  intent: ParsedIntent
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): EditPlan | null {
  const { session, intent, message, slug, currentPage, activeBlockId, activeEditablePath } = args
  const lowerMessage = message.toLowerCase()
  const routeMentions = extractRouteMentions(message)
  const assumptions: string[] = []
  if (intent.assumption) assumptions.push(intent.assumption)

  const selectedBlock = activeBlockId ? currentPage.blocks.find((b) => b.id === activeBlockId) ?? null : null
  const secondaryButtonMentioned =
    lowerMessage.includes("secondary cta") ||
    lowerMessage.includes("secondary button") ||
    lowerMessage.includes("second cta") ||
    lowerMessage.includes("second button") ||
    /sec\w*nd\w*ry\s+(cta|button)/.test(lowerMessage)
  const asksSecondaryCtaAdd =
    secondaryButtonMentioned &&
    (lowerMessage.includes("add") || lowerMessage.includes("create") || lowerMessage.includes("insert") || lowerMessage.includes("include"))

  const asksPageRename = isPageRouteRenameRequest(message)
  if ((intent.action === "update" || intent.action === "move" || intent.action === "clarify") && asksPageRename) {
    const fromSlug = routeMentions[0] ?? slug
    const toSlug = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
    if (!toSlug || toSlug === fromSlug) {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please provide the target page path, for example: rename page from /old to /new.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Renamed page path from ${fromSlug} to ${toSlug}.`,
      change_log: [...assumptions, `Renamed page ${fromSlug} -> ${toSlug}.`],
      ops: [{ op: "rename_page", pageSlug: fromSlug, newPageSlug: toSlug }]
    }
  }

  const asksPageDelete = /\b(delete|remove)\b.*\bpage\b/.test(lowerMessage)
  if ((intent.action === "remove" || intent.action === "clarify") && asksPageDelete) {
    const targetSlug = routeMentions[0] ?? slug
    if (targetSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) cannot be deleted. Choose another page path.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Deleted page ${targetSlug}.`,
      change_log: [...assumptions, `Removed page ${targetSlug}.`],
      ops: [{ op: "remove_page", pageSlug: targetSlug }]
    }
  }

  const asksNavMove =
    /\b(nav|navigation|menu|tabs?|tab order|page order)\b/.test(lowerMessage) ||
    /\bmove\b.*\b(page|tab)\b/.test(lowerMessage) ||
    /\breorder\b.*\b(page|nav|menu|tabs?)\b/.test(lowerMessage)
  if ((intent.action === "move" || intent.action === "clarify") && asksNavMove) {
    const sessionDraft = getSessionDraft(session)
    const slugsRaw = Array.from(sessionDraft.keys())
    const ordered = slugsRaw.includes("/") ? ["/", ...slugsRaw.filter((route) => route !== "/")] : slugsRaw
    const movedSlug = routeMentions[0] ?? slug
    if (!ordered.includes(movedSlug)) {
      return {
        intent: "needs_clarification",
        summary_for_user: `I could not find page ${movedSlug}.`,
        change_log: assumptions,
        ops: []
      }
    }
    if (movedSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) is fixed at the first position in navigation.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterPageSlug: string | undefined
    if (/\b(top|first|start|beginning)\b/.test(lowerMessage)) {
      afterPageSlug = undefined
    } else if (/\b(bottom|last|end)\b/.test(lowerMessage)) {
      const tail = [...ordered].reverse().find((route) => route !== movedSlug)
      afterPageSlug = tail === "/" ? "/" : tail
    } else if (/\b(after|below|under)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else if (/\b(before|above)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      const anchor = routeMentions[1]
      if (anchor === "/") afterPageSlug = undefined
      else {
        const index = ordered.findIndex((route) => route === anchor)
        if (index === -1) {
          return {
            intent: "needs_clarification",
            summary_for_user: `I could not find anchor page ${anchor}.`,
            change_log: assumptions,
            ops: []
          }
        }
        const previous = ordered.slice(0, index).reverse().find((route) => route !== movedSlug)
        afterPageSlug = previous === "/" ? "/" : previous
      }
    } else if (routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Specify where to place the page (first/last/before/after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user:
        afterPageSlug === undefined
          ? `Moved ${movedSlug} to the first nav position (after Home).`
          : `Moved ${movedSlug} after ${afterPageSlug}.`,
      change_log: [...assumptions, `Reordered nav: ${movedSlug}`],
      ops: [{ op: "move_page", pageSlug: movedSlug, afterPageSlug }]
    }
  }

  if (
    selectedBlock?.type === "Hero" &&
    asksSecondaryCtaAdd &&
    (intent.action === "add" || intent.action === "clarify" || intent.action === "update")
  ) {
    const heroProps = selectedBlock.props as Record<string, unknown>
    const existingText = typeof heroProps.secondaryCtaText === "string" ? heroProps.secondaryCtaText.trim() : ""
    const existingHref = typeof heroProps.secondaryCtaHref === "string" ? heroProps.secondaryCtaHref.trim() : ""
    const quoted = quotedText(message)
    const patch: Record<string, unknown> = {
      secondaryCtaText: quoted ?? (existingText.length > 0 ? existingText : "Learn more"),
      secondaryCtaHref: existingHref.length > 0 ? existingHref : "/"
    }

    return {
      intent: "edit_plan",
      summary_for_user: "Added a secondary CTA button to the selected Hero.",
      change_log: [...assumptions, `Updated ${selectedBlock.id}: secondaryCtaText, secondaryCtaHref`],
      ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
    }
  }

  const asksInlineAdd =
    lowerMessage.includes("add") &&
    (lowerMessage.includes("inside") ||
      lowerMessage.includes("within") ||
      lowerMessage.includes("current") ||
      lowerMessage.includes("this one") ||
      lowerMessage.includes("more"))

  if ((intent.action === "add" || intent.action === "clarify") && selectedBlock && asksInlineAdd) {
    const patch = buildListAppendPatch(selectedBlock, message)
    if (patch) {
      return {
        intent: "edit_plan",
        summary_for_user: `Updated ${selectedBlock.type}.`,
        change_log: [...assumptions, `Added one entry to ${selectedBlock.id}.`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
      }
    }
  }

  if (intent.action === "info" || (intent.action === "clarify" && !activeEditablePath)) {
    return {
      intent: "needs_clarification",
      summary_for_user: intent.summary ?? "Please specify the section and exact change you want.",
      change_log: assumptions,
      ops: []
    }
  }

  if (intent.action === "remove") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to remove.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Removed ${target.type}.`,
      change_log: [...assumptions, `Removed block ${target.id}.`],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: target.id }]
    }
  }

  if (intent.action === "update" || (intent.action === "clarify" && !!activeEditablePath)) {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to update.",
        change_log: assumptions,
        ops: []
      }
    }
    const childPatch = coercePatchForEditablePath(target, activeEditablePath, intent.patch, message)
    const patch = childPatch?.patch ?? coercePatchForBlock(target, intent.patch)
    if (Object.keys(patch).length === 0) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify at least one valid field for ${target.type}.`,
        change_log: [...assumptions, `Editable fields: ${Object.keys(target.props).join(", ")}`],
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Updated ${target.type}.`,
      change_log: [
        ...assumptions,
        childPatch
          ? `Updated ${target.id} ${activeEditablePath}: ${childPatch.changedKeys.join(", ")}`
          : `Updated ${target.id}: ${Object.keys(patch).join(", ")}`
      ],
      ops: [{ op: "update_props", pageSlug: slug, blockId: target.id, patch }]
    }
  }

  if (intent.action === "move") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to move.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterBlockId: string | undefined
    if (intent.position === "top") {
      afterBlockId = undefined
    } else if (intent.position === "bottom") {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move after.",
          change_log: assumptions,
          ops: []
        }
      }
      afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) afterBlockId = currentPage.blocks[idx - 1]?.id
      else afterBlockId = undefined
    } else if (message.toLowerCase().includes("bottom") || message.toLowerCase().includes("end")) {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please specify where to move the block (top, bottom, before, after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Moved ${target.type}.`,
      change_log: [...assumptions, `Moved block ${target.id}.`],
      ops: [{ op: "move_block", pageSlug: slug, blockId: target.id, afterBlockId }]
    }
  }

  if (intent.action === "add") {
    const blockType =
      intent.new_block_type ??
      inferAddedBlockTypeFromMessage(message) ??
      intent.target_block_type ??
      inferBlockTypeFromText(intent.target_block_ref ?? "") ??
      inferBlockTypeFromText(message)
    if (!blockType) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify which block type to add (${allowedBlockTypes.join(", ")}).`,
        change_log: assumptions,
        ops: []
      }
    }

    const blockId = nextBlockId(blockType, currentPage)
    const baseProps = defaultPropsForType(blockType)
    const patch = coercePatchForBlock({ id: blockId, type: blockType, props: baseProps }, intent.patch)
    const props = { ...baseProps, ...patch }

    const addOp: Operation = {
      op: "add_block",
      pageSlug: slug,
      block: { id: blockId, type: blockType, props }
    }

    let extraMoveTop: Operation | null = null
    if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this after.",
          change_log: assumptions,
          ops: []
        }
      }
      addOp.afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) addOp.afterBlockId = currentPage.blocks[idx - 1]?.id
      else extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "top") {
      extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "bottom" || !intent.position) {
      // no-op: add without anchor appends to bottom in applyOpsAtomically
    }

    const ops: Operation[] = extraMoveTop ? [addOp, extraMoveTop] : [addOp]
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Added ${blockType}.`,
      change_log: [...assumptions, `Added ${blockType} block ${blockId}.`],
      ops
    }
  }

  return null
}

async function parseIntentWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
}): Promise<ParsedIntent> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const system = [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields."
  ].join("\n")

  const user = {
    request: args.message,
    slug: args.slug,
    activeBlockId: args.activeBlockId ?? null,
    activeBlockType: args.activeBlockType ?? null,
    activeEditablePath: args.activeEditablePath ?? null,
    availableBlockTypes: allowedBlockTypes,
    blocks: args.currentPage.blocks.map((b) => ({ id: b.id, type: b.type, props: Object.keys(b.props) }))
  }

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Intent parser did not return JSON")
  const parsedRoot = JSON.parse(jsonText) as Record<string, unknown>
  const normalized = { ...parsedRoot } as Record<string, unknown>

  if (typeof normalized.action !== "string") {
    const intent = typeof normalized.intent === "string" ? normalized.intent : undefined
    if (intent === "needs_clarification") normalized.action = "clarify"
    if (intent === "info") normalized.action = "info"
  }

  if (
    typeof normalized.action !== "string" &&
    Array.isArray(normalized.ops) &&
    normalized.ops.length > 0 &&
    normalized.ops[0] &&
    typeof normalized.ops[0] === "object"
  ) {
    const first = normalized.ops[0] as Record<string, unknown>
    const op = normalizeOpName(first.op ?? first.operation ?? first.action ?? first.kind)
    if (op === "add_block") {
      normalized.action = "add"
      const block = first.block && typeof first.block === "object" ? (first.block as Record<string, unknown>) : null
      if (block && typeof block.type === "string") normalized.new_block_type = block.type
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "bottom"
      }
      if (block && typeof block.props === "object" && block.props !== null && !Array.isArray(block.props)) {
        normalized.patch = block.props
      }
    } else if (op === "update_props") {
      normalized.action = "update"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (first.patch && typeof first.patch === "object" && !Array.isArray(first.patch)) normalized.patch = first.patch
    } else if (op === "remove_block") {
      normalized.action = "remove"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
    } else if (op === "move_block") {
      normalized.action = "move"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "top"
      }
    }
  }

  const parsed = intentSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const detail = issue?.message ?? "Invalid intent parser output"
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`${detail}${at}`)
  }
  return parsed.data
}

async function generatePlanWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof plannerContextPack>
  model: string
  feedback?: string
  onToken?: (token: string) => void
}): Promise<EditPlan> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const explicitOtherReference =
    selectedBlockId.length > 0 &&
    Array.isArray(args.contextPack.resolvedReferences.mentionedBlocks) &&
    args.contextPack.resolvedReferences.mentionedBlocks.some(
      (entry) => entry && typeof entry === "object" && "id" in entry && (entry as { id?: unknown }).id !== selectedBlockId
    )

  const system = [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, rename_page, remove_page, move_page, duplicate_page.",
    "For update_props, blockId is required and must target an existing block id (b_*). Never use a page route/path as blockId or path.",
    "Use rename_page for page route changes (pageSlug -> newPageSlug).",
    "Use remove_page when the user asks to delete a page path.",
    "Use move_page to reorder nav pages (pageSlug + optional afterPageSlug). Home (/) must stay first.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For Hero imageUrl, only use https://picsum.photos/seed/{keyword}/1600/900 or a URL explicitly provided by the user. Never invent image paths.",
    selectedBlockId.length > 0 && !explicitOtherReference
      ? `Selected block is ${selectedBlockId}. You MUST target only this block in ops unless the user explicitly names a different section.`
      : "Respect explicit user target references when present.",
    `Allowed block types: ${allowedBlockTypes.join(", ")}.`
  ].join("\n")

  const user = {
    request: args.message,
    slug: args.slug,
    contextPack: args.contextPack,
    blockContracts: blockContractsSummary(),
    knownBlockTypes: Object.keys(blockSchemas),
    editPlanShape: {
      intent: "edit_plan | needs_clarification",
      summary_for_user: "string",
      change_log: ["string"],
      ops: ["Operation[]"]
    },
    feedback: args.feedback ?? null
  }

  let raw = ""
  if (args.onToken) {
    const stream = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (typeof delta !== "string" || delta.length === 0) continue
      raw += delta
      args.onToken(delta)
    }
  } else {
    const completion = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    raw = completion.choices[0]?.message?.content ?? ""
  }
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Model did not return JSON")

  const parsed = normalizePlanCandidate(JSON.parse(jsonText), {
    defaultSlug: args.slug,
    currentPage: args.currentPage,
    userMessage: args.message
  })
  const planResult = editPlanSchema.safeParse(parsed)
  if (!planResult.success) {
    const first = planResult.error.issues[0]
    const message = first?.message ?? "Invalid model output"
    const path = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const sample = JSON.stringify(parsed).slice(0, 700)
    throw new Error(`${message}${path}. Parsed sample: ${sample}`)
  }

  return planResult.data
}

function toErrorDetail(error: unknown) {
  if (error instanceof Error) {
    const issueMatch = /"message"\s*:\s*"([^"]+)"/.exec(error.message)
    if (issueMatch?.[1]) return issueMatch[1]
    return error.message
  }
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    const first = (error as { issues: Array<{ message?: unknown; path?: unknown[] }> }).issues[0]
    if (first) {
      const msg = typeof first.message === "string" ? first.message : "Invalid model output"
      const path = Array.isArray(first.path) && first.path.length > 0 ? ` at ${first.path.join(".")}` : ""
      return `${msg}${path}`
    }
  }
  if (typeof error === "string") return error
  return "Unknown planner error"
}

function applyOpsAtomically(session: string, ops: Operation[]) {
  const nextUniqueBlockId = (blocks: Array<{ id: string }>, preferred: string) => {
    const base = preferred.trim()
    if (base.length > 0 && !blocks.some((b) => b.id === base)) return base
    const root = base.length > 0 ? base : "b_block_copy"
    let i = 1
    while (blocks.some((b) => b.id === `${root}_${i}`)) i += 1
    return `${root}_${i}`
  }

  const nextDuplicateSlug = (candidateMap: Map<string, PageDoc>, sourceSlug: string) => {
    const base = sourceSlug === "/" ? "/home-copy" : `${sourceSlug.replace(/\/+$/, "")}-copy`
    if (!candidateMap.has(base)) return base
    let i = 2
    while (candidateMap.has(`${base}-${i}`)) i += 1
    return `${base}-${i}`
  }

  const rebuildOrderWithInserted = (candidateMap: Map<string, PageDoc>, insertedSlug: string, afterPageSlug?: string) => {
    const ordered = orderSlugsHomeFirst(Array.from(candidateMap.keys()))
    const withoutInserted = ordered.filter((slug) => slug !== insertedSlug)
    let insertIndex = 0
    if (afterPageSlug) {
      if (afterPageSlug === "/") insertIndex = 1
      else {
        const anchorIdx = withoutInserted.findIndex((slug) => slug === afterPageSlug)
        if (anchorIdx === -1) throw new Error(`afterPageSlug ${afterPageSlug} not found`)
        insertIndex = anchorIdx + 1
      }
    }
    withoutInserted.splice(insertIndex, 0, insertedSlug)
    return withoutInserted
  }

  const sessionDraft = getSessionDraft(session)
  const staged = new Map<string, PageDoc>()
  for (const [slug, page] of sessionDraft) staged.set(slug, structuredClone(page))
  const touchedSlugs = new Set<string>()
  const deletedSlugs = new Set<string>()
  let orderChanged = false

  for (const op of ops) {
    if (op.op === "create_page") {
      staged.set(op.page.slug, structuredClone(op.page))
      touchedSlugs.add(op.page.slug)
      continue
    }

    if (op.op === "duplicate_page") {
      const source = staged.get(op.pageSlug)
      if (!source) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextSlug = normalizeRouteCandidate(op.newPageSlug) ?? nextDuplicateSlug(staged, op.pageSlug)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      op.newPageSlug = nextSlug
      const copy: PageDoc = {
        ...structuredClone(source),
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : `${source.title} Copy`,
        updatedAt: new Date().toISOString(),
        blocks: source.blocks.map((block) => ({ ...structuredClone(block), id: nextUniqueBlockId(source.blocks, `${block.id}_copy`) }))
      }
      staged.set(nextSlug, copy)
      touchedSlugs.add(nextSlug)

      const finalOrder = rebuildOrderWithInserted(staged, nextSlug, op.afterPageSlug ?? op.pageSlug)
      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (page) reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    if (op.op === "rename_page") {
      const nextSlug = normalizeRouteCandidate(op.newPageSlug)
      if (!nextSlug) throw new Error(`Invalid newPageSlug ${op.newPageSlug}`)
      if (op.pageSlug === nextSlug) throw new Error(`No effective page change for ${op.pageSlug}`)
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      staged.set(nextSlug, {
        ...page,
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : pageTitleFromSlug(nextSlug),
        updatedAt: new Date().toISOString()
      })
      touchedSlugs.add(nextSlug)

      // Keep route references consistent after a slug change.
      for (const [slug, candidate] of staged) {
        const rewritten = rewriteLinksToRenamedPage(candidate, op.pageSlug, nextSlug)
        if (!rewritten.changed) continue
        staged.set(slug, rewritten.page)
        touchedSlugs.add(slug)
      }
      continue
    }

    if (op.op === "remove_page") {
      if (op.pageSlug === "/") throw new Error("Cannot remove the home page (/)")
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.size <= 1) throw new Error("Cannot remove the last remaining page")
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      continue
    }

    if (op.op === "move_page") {
      if (op.pageSlug === "/") throw new Error("Home page (/) cannot be moved")
      if (!staged.has(op.pageSlug)) throw new Error(`Page not found for slug ${op.pageSlug}`)

      const ordered = orderSlugsHomeFirst(Array.from(staged.keys()))
      const movable = ordered.filter((route) => route !== "/")
      const currentIdx = movable.findIndex((route) => route === op.pageSlug)
      if (currentIdx === -1) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextMovable = movable.filter((route) => route !== op.pageSlug)

      let insertIndex = 0
      if (op.afterPageSlug) {
        if (op.afterPageSlug === "/") insertIndex = 0
        else {
          const anchorIdx = nextMovable.findIndex((route) => route === op.afterPageSlug)
          if (anchorIdx === -1) throw new Error(`afterPageSlug ${op.afterPageSlug} not found`)
          insertIndex = anchorIdx + 1
        }
      }

      nextMovable.splice(insertIndex, 0, op.pageSlug)
      const finalOrder = ordered.includes("/") ? ["/", ...nextMovable] : nextMovable

      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (!page) continue
        reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    const page = staged.get(op.pageSlug)
    if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)

    if (op.op === "add_block") {
      const propCheck = validateBlockProps(op.block.type, op.block.props)
      if (!propCheck.success) throw new Error(`Invalid props for ${op.block.type}`)

      const alreadyExists = page.blocks.some((b) => b.id === op.block.id)
      if (alreadyExists) throw new Error(`Block id ${op.block.id} already exists`)

      if (!op.afterBlockId) {
        page.blocks.push({ ...op.block, props: propCheck.data })
      } else {
        const idx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (idx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(idx + 1, 0, { ...op.block, props: propCheck.data })
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "duplicate_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const source = page.blocks[idx]
      const nextId = nextUniqueBlockId(page.blocks, typeof op.newBlockId === "string" ? op.newBlockId : `${source.id}_copy`)
      op.newBlockId = nextId
      const duplicate = { ...structuredClone(source), id: nextId }

      if (!op.afterBlockId) {
        page.blocks.splice(idx + 1, 0, duplicate)
      } else {
        const anchorIdx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (anchorIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(anchorIdx + 1, 0, duplicate)
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_props") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[idx]
      const rawPatch = op.patch as Record<string, unknown>
      const patchCandidate =
        rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
          ? (rawPatch.props as Record<string, unknown>)
          : rawPatch

      const patchKeys = Object.keys(patchCandidate ?? {})
      const schemaForType = blockSchemas[block.type as BlockType]
      const schemaShape =
        schemaForType && typeof schemaForType === "object" && "shape" in schemaForType
          ? (schemaForType.shape as Record<string, unknown>)
          : null
      const allowedPatchKeys = schemaShape ? Object.keys(schemaShape) : Object.keys(block.props as Record<string, unknown>)
      const invalidPatchKeys = patchKeys.filter((key) => !allowedPatchKeys.includes(key))
      if (invalidPatchKeys.length > 0) {
        throw new Error(
          `Patch for ${block.id} (${block.type}) used unknown props: ${invalidPatchKeys.join(", ")}. Allowed props: ${allowedPatchKeys.join(", ")}`
        )
      }

      const nextProps = { ...block.props, ...patchCandidate } as Record<string, unknown>

      const propCheck = validateBlockProps(block.type as BlockType, nextProps)
      if (!propCheck.success) throw new Error(`Invalid props for ${block.type}`)
      if (JSON.stringify(block.props) === JSON.stringify(propCheck.data)) {
        throw new Error(`No effective prop change for ${block.id}. Patch keys: ${patchKeys.join(", ") || "(none)"}`)
      }
      page.blocks[idx] = { ...block, props: propCheck.data }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      page.blocks.splice(idx, 1)
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const [block] = page.blocks.splice(idx, 1)

      if (!op.afterBlockId) {
        page.blocks.unshift(block)
      } else {
        const afterIdx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (afterIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(afterIdx + 1, 0, block)
      }

      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
    }
  }

  if (touchedSlugs.size === 0 && deletedSlugs.size === 0 && !orderChanged) {
    throw new Error("Edit plan produced no changes")
  }

  sessionDraft.clear()
  for (const [route, page] of staged) {
    setPage(session, page)
  }
}

function pickFocusBlockId(ops: Operation[]) {
  const add = ops.find((op) => op.op === "add_block")
  if (add && add.op === "add_block") return add.block.id

  const duplicate = ops.find((op) => op.op === "duplicate_block")
  if (duplicate && duplicate.op === "duplicate_block" && typeof duplicate.newBlockId === "string") return duplicate.newBlockId

  const move = ops.find((op) => op.op === "move_block")
  if (move && move.op === "move_block") return move.blockId

  const update = ops.find((op) => op.op === "update_props")
  if (update && update.op === "update_props") return update.blockId

  return undefined
}

function pickUpdatedSlug(session: string, currentSlug: string, ops: Operation[]) {
  const duplicate = ops.find((op) => op.op === "duplicate_page" && op.pageSlug === currentSlug)
  if (duplicate && duplicate.op === "duplicate_page") return duplicate.newPageSlug
  const rename = ops.find((op) => op.op === "rename_page" && op.pageSlug === currentSlug)
  if (rename && rename.op === "rename_page") return rename.newPageSlug
  const current = getPage(session, currentSlug)
  if (current) return undefined
  const draft = getSessionDraft(session)
  const first = orderSlugsHomeFirst(Array.from(draft.keys()))[0]
  return first
}

function collectMentionedSlugsFromPlan(plan: EditPlan, fallbackSlug?: string) {
  const seen = new Set<string>()
  const removed = new Set<string>()
  const push = (slug?: string) => {
    if (!slug || typeof slug !== "string") return
    const normalized = normalizeRouteCandidate(slug)
    if (!normalized) return
    seen.add(normalized)
  }

  for (const op of plan.ops) {
    if (op.op === "create_page") {
      push(op.page.slug)
      continue
    }
    if (op.op === "rename_page") {
      // Old slug is not navigable after rename; only link to the new route.
      push(op.newPageSlug)
      continue
    }
    if (op.op === "remove_page") {
      const normalized = normalizeRouteCandidate(op.pageSlug)
      if (normalized) removed.add(normalized)
      continue
    }
    if (op.op === "move_page") {
      push(op.pageSlug)
      push(op.afterPageSlug)
      continue
    }
    if (op.op === "duplicate_page") {
      push(op.pageSlug)
      push(op.newPageSlug)
      push(op.afterPageSlug)
      continue
    }
    push(op.pageSlug)
  }

  for (const slug of removed) seen.delete(slug)
  if (seen.size === 0) {
    const normalizedFallback = normalizeRouteCandidate(fallbackSlug)
    if (normalizedFallback && !removed.has(normalizedFallback)) seen.add(normalizedFallback)
  }
  return orderSlugsHomeFirst(Array.from(seen))
}

function collectMentionedSlugsFromOps(ops: Operation[], fallbackSlug?: string) {
  return collectMentionedSlugsFromPlan(
    {
      intent: "edit_plan",
      summary_for_user: "",
      change_log: [],
      ops
    },
    fallbackSlug
  )
}

function normalizePlanCopyForUi(plan: EditPlan, currentPage: PageDoc): EditPlan {
  const rewrite = (text: string) =>
    text
      .replace(/\bhome page secondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bsecondary cta\b/gi, "Hero secondary CTA")

  const normalizedSummary = rewrite(plan.summary_for_user)
  const normalizedChangeLog = plan.change_log.map(rewrite)

  if (plan.intent !== "edit_plan" || plan.ops.length !== 1) return plan
  const [op] = plan.ops
  if (op.op !== "update_props") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const block = currentPage.blocks.find((entry) => entry.id === op.blockId)
  if (!block || block.type !== "Hero") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const patch = op.patch as Record<string, unknown>
  const hasSecondaryText = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaText")
  const hasSecondaryHref = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaHref")
  if (!hasSecondaryText && !hasSecondaryHref) return plan

  const nextSummary = "Renamed the Hero secondary CTA."
  const nextChangeLog = ["Updated the Hero secondary CTA text/link."]
  return {
    ...plan,
    summary_for_user: nextSummary,
    change_log: nextChangeLog
  }
}

function resolveEffectiveSlug(args: { session: string; requestedSlug: string; activeBlockId?: string }) {
  const { session, requestedSlug, activeBlockId } = args
  if (!activeBlockId) return requestedSlug
  const current = getPage(session, requestedSlug)
  if (current?.blocks.some((block) => block.id === activeBlockId)) return requestedSlug
  const draft = getSessionDraft(session)
  for (const [slug, page] of draft) {
    if (page.blocks.some((block) => block.id === activeBlockId)) return slug
  }
  return requestedSlug
}

function isNoEffectiveChangeError(reason: string) {
  return /No effective prop change/i.test(reason)
}

async function runChatPipeline(
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onOpApplied?: (event: { index: number; total: number; op: Operation; previewVersion: number; focusBlockId?: string }) => void
  }
): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  if (!body.session || !body.slug || !body.message) {
    return { code: 400, payload: { error: "session, slug, and message are required" } }
  }
  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: body.activeBlockId
  })

  const modelKey = body.modelKey && modelLookup[body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = modelLookup[modelKey]
  const plannerSource: "openai" | "demo" = process.env.OPENAI_API_KEY ? "openai" : "demo"

  const current = getPage(body.session, effectiveSlug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (isInfoQuery(body.message)) {
    return infoResponse({ body, current, plannerSource, modelUsed, modelKey })
  }

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: body.message,
    currentPage: current,
    activeBlockId: body.activeBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: body.activeEditablePath
  })

  const respondFromPlan = (plan: EditPlan, source: "openai" | "demo") => {
    let resolvedPlan = normalizePlanCopyForUi(plan, current)

    if (resolvedPlan.intent === "needs_clarification" && body.activeBlockId) {
      const focusedFallback = compileDeterministicPlan({
        session: body.session ?? "dev",
        intent: { action: "clarify" },
        message: body.message ?? "",
        slug: effectiveSlug ?? "/",
        currentPage: current,
        activeBlockId: body.activeBlockId,
        activeEditablePath: body.activeEditablePath
      })
      if (focusedFallback?.intent === "edit_plan" && focusedFallback.ops.length > 0) {
        resolvedPlan = focusedFallback
      }
    }

    if (resolvedPlan.intent === "needs_clarification" && isBlockCatalogQuery(body.message!)) {
      const forcedInfo = infoResponse({ body, current, plannerSource: source, modelUsed, modelKey })
      return { done: true as const, response: forcedInfo }
    }

    if (resolvedPlan.intent === "needs_clarification") {
      const selected =
        body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
          ? current.blocks.find((b) => b.id === body.activeBlockId)
          : null
      return {
        done: true as const,
        response: {
          code: 200,
          payload: {
            status: "needs_clarification",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            suggestions: clarificationSuggestions({ body, current, selected }),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult
        }
      }
    }

    const previous = getPage(body.session!, effectiveSlug)
    if (!previous) {
      return {
        done: true as const,
        response: { code: 404, payload: { error: "page not found" } as { error: string } }
      }
    }

    try {
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (options?.onOpApplied && !hasPageStructuralOps) {
        const rollbackBySlug = new Map<string, PageDoc>()
        for (const op of resolvedPlan.ops) {
          const slug = op.op === "create_page" ? op.page.slug : op.pageSlug
          if (rollbackBySlug.has(slug)) continue
          const existing = getPage(body.session!, slug)
          if (existing) rollbackBySlug.set(slug, structuredClone(existing))
        }

        // Validate the whole plan from the current state before progressive apply.
        applyOpsAtomically(body.session!, resolvedPlan.ops)

        // Roll back to pre-apply state so we can replay ops progressively.
        for (const [slug, snapshot] of rollbackBySlug) {
          setPage(body.session!, { ...snapshot, slug })
        }
        for (const op of resolvedPlan.ops) {
          if (op.op === "create_page") {
            if (rollbackBySlug.has(op.page.slug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.page.slug)!))
              continue
            }
            const sessionDraft = getSessionDraft(body.session!)
            sessionDraft.delete(op.page.slug)
            continue
          }
          if (op.op === "rename_page") {
            const sessionDraft = getSessionDraft(body.session!)
            if (rollbackBySlug.has(op.newPageSlug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.newPageSlug)!))
            } else {
              sessionDraft.delete(op.newPageSlug)
            }
          }
        }

        const total = resolvedPlan.ops.length
        for (let index = 0; index < total; index += 1) {
          const op = resolvedPlan.ops[index]
          applyOpsAtomically(body.session!, [op])
          const previewVersion = bumpVersion(body.session!)
          options.onOpApplied({
            index: index + 1,
            total,
            op,
            previewVersion,
            focusBlockId: pickFocusBlockId([op])
          })
        }
      } else {
        applyOpsAtomically(body.session!, resolvedPlan.ops)
      }
      pushUndo(body.session!, effectiveSlug, previous)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: resolvedPlan.summary_for_user, ops: resolvedPlan.ops })
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      schedulePersistState()
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      return {
        done: true as const,
        response: {
          code: 200,
          payload: {
            status: "applied",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
            previewVersion,
            focusBlockId,
            updatedSlug,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult
        }
      }
    } catch (error) {
      const reason = toErrorDetail(error)
      if (isNoEffectiveChangeError(reason)) {
        return {
          done: true as const,
          response: {
            code: 200,
            payload: {
              status: "applied",
              summary: "No changes needed. That content is already up to date.",
              changes: [],
              mentionedSlugs: [effectiveSlug],
              previewVersion: versions.get(body.session!) ?? 0,
              plannerSource: source,
              modelUsed,
              modelKey
            } satisfies ChatResult
          }
        }
      }
      return { done: false as const, reason }
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    try {
      const demoPlan = demoPlanFromMessage(body.message, effectiveSlug, body.activeBlockId, body.activeBlockType)
      const outcome = respondFromPlan(demoPlan, "demo")
      if (outcome.done) return outcome.response
      return {
        code: 400,
        payload: {
          status: "validation_error",
          summary: "I could not apply that change safely.",
          changes: [],
          validationErrors: [outcome.reason],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }
      }
    } catch (error) {
      return {
        code: 500,
        payload: {
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [toErrorDetail(error).slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }
      }
    }
  }

  const maxAttempts = 3
  const repairFeedback: string[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let plan: EditPlan
    try {
      plan = await generatePlanWithOpenAI({
        message: body.message,
        slug: effectiveSlug,
        currentPage: current,
        contextPack,
        model: modelUsed,
        feedback: repairFeedback.length > 0 ? repairFeedback.join(" | ") : undefined,
        onToken: options?.onPlanningToken
      })
    } catch (error) {
      const reason = toErrorDetail(error)
      repairFeedback.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxAttempts) {
        return {
          code: 500,
          payload: {
            status: "error",
            summary: "Could not generate an edit plan.",
            changes: [reason.slice(0, 300)],
            validationErrors: repairFeedback.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }
        }
      }
      continue
    }

    const outcome = respondFromPlan(plan, "openai")
    if (outcome.done) return outcome.response
    repairFeedback.push(`Attempt ${attempt} apply failed: ${outcome.reason}`)
  }

  try {
    const fallbackPlan = demoPlanFromMessage(body.message, effectiveSlug, body.activeBlockId, body.activeBlockType)
    const fallbackOutcome = respondFromPlan(fallbackPlan, "demo")
    if (fallbackOutcome.done) return fallbackOutcome.response
    repairFeedback.push(`Demo fallback apply failed: ${fallbackOutcome.reason}`)
  } catch (error) {
    repairFeedback.push(`Demo fallback planning failed: ${toErrorDetail(error)}`)
  }

  return {
    code: 400,
    payload: {
      status: "validation_error",
      summary: "I could not apply that change safely.",
      changes: [],
      validationErrors: repairFeedback.slice(-4),
      previewVersion: versions.get(body.session) ?? 0,
      plannerSource: "demo",
      modelUsed,
      modelKey
    }
  }
}

function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  const stream = reply.raw as NodeJS.WritableStream & {
    destroyed?: boolean
    writableEnded?: boolean
    writable?: boolean
  }
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // Client disconnected; ignore write errors for SSE.
  }
}

app.get("/published/pages", async (request, reply) => {
  const query = request.query as { slug?: string }
  if (!query.slug) return reply.code(400).send({ error: "slug is required" })

  const page = publishedPages.get(query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })
  return structuredClone(page)
})

app.get("/draft/pages", async (request, reply) => {
  const query = request.query as { session?: string; slug?: string }
  if (!query.slug || !query.session) return reply.code(400).send({ error: "session and slug are required" })

  const page = getPage(query.session, query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })

  return structuredClone(page)
})

app.get("/draft/slugs", async (request, reply) => {
  const query = request.query as { session?: string }
  const session = query.session ?? "dev"
  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return { slugs }
})

app.get("/publish/content", async (request, reply) => {
  const query = request.query as { session?: string }
  const session = query.session ?? "dev"
  const pages = getSessionPages(session)
  return {
    session,
    slugs: pages.map((page) => page.slug),
    pages,
    generatedAt: new Date().toISOString()
  }
})

app.post("/publish", async (request, reply) => {
  if (!requirePublishToken(request as { headers: Record<string, unknown> })) {
    return reply.code(401).send({ error: "invalid publish token" })
  }

  const body = (request.body ?? {}) as { session?: string }
  const session = body.session ?? "dev"
  const publishMode = (process.env.PUBLISH_MODE?.trim().toLowerCase() || "deploy_hook") as "deploy_hook" | "git"

  if (publishMode === "git") {
    const result = await publishViaGit(session)
    const tracker: PublishTracker = {
      session,
      status: result.status === "failed" ? "failed" : "triggered",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slugs: result.slugs,
      vercelState: result.status === "failed" ? "ERROR" : "READY",
      deployResponse: "git_publish",
      deployStatus: result.status === "failed" ? 500 : 200
    }
    publishStatusBySession.set(session, tracker)

    if (result.status === "failed") {
      return reply.code(400).send({
        status: "failed",
        session: result.session,
        slugs: result.slugs,
        reason: result.reason,
        details: result.details
      })
    }

    return {
      status: result.status,
      session: result.session,
      slugs: result.slugs,
      branch: result.branch,
      commitSha: result.commitSha,
      message: result.message,
      vercelState: result.vercelState ?? "READY"
    }
  }

  const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
  if (!deployHookUrl) {
    return reply.code(400).send({ error: "VERCEL_DEPLOY_HOOK_URL is not configured" })
  }

  const pages = getSessionPages(session)
  const slugs = pages.map((page) => page.slug)

  try {
    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "orchestrator",
        session,
        slugs,
        publishedAt: new Date().toISOString()
      })
    })

    const responseText = await hookResponse.text()
    const responseJson = parseJsonMaybe(responseText)
    const inspectUrl =
      findStringByKeys(responseJson, new Set(["inspectorUrl", "inspectUrl", "url"])) ?? firstUrlFromText(responseText)
    const deploymentId =
      findStringByKeys(responseJson, new Set(["deploymentId", "id"])) ??
      (inspectUrl ? deploymentIdFromAny(inspectUrl) : undefined) ??
      deploymentIdFromAny(responseText)
    const vercelStateRaw =
      findStringByKeys(responseJson, new Set(["state", "readyState", "status"])) ??
      (hookResponse.ok ? "TRIGGERED" : "FAILED")
    const vercelState = typeof vercelStateRaw === "string" ? vercelStateRaw.toUpperCase() : undefined

    const tracker: PublishTracker = {
      session,
      status: hookResponse.ok ? "triggered" : "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slugs,
      deployStatus: hookResponse.status,
      deployResponse: responseText.slice(0, 500),
      inspectUrl,
      deploymentId,
      vercelState
    }
    publishStatusBySession.set(session, tracker)

    return {
      status: hookResponse.ok ? "triggered" : "failed",
      session,
      slugs,
      deployStatus: hookResponse.status,
      deployResponse: responseText.slice(0, 500),
      inspectUrl,
      deploymentId,
      vercelState
    }
  } catch (error) {
    return reply.code(502).send({ error: toErrorDetail(error) })
  }
})

app.get("/publish/status", async (request, reply) => {
  const query = request.query as { session?: string }
  const session = query.session ?? "dev"
  const current = publishStatusBySession.get(session)
  if (!current) return reply.code(404).send({ error: "no publish status for session" })
  const refreshed = await refreshPublishStatusFromVercel(current)
  publishStatusBySession.set(session, refreshed)
  return refreshed
})

app.post("/ops", async (request, reply) => {
  const body = request.body as ApplyOpsRequestBody
  const session = body.session ?? "dev"
  const parsedOps = z.array(operationSchema).safeParse(body.ops)
  if (!parsedOps.success) return reply.code(400).send({ error: "invalid ops payload" })
  if (parsedOps.data.length === 0) return reply.code(400).send({ error: "ops must not be empty" })

  const snapshots = new Map<string, PageDoc>()
  for (const op of parsedOps.data) {
    if (!("pageSlug" in op) || typeof op.pageSlug !== "string") continue
    if (snapshots.has(op.pageSlug)) continue
    const current = getPage(session, op.pageSlug)
    if (!current) return reply.code(404).send({ error: `page not found: ${op.pageSlug}` })
    snapshots.set(op.pageSlug, current)
  }

  try {
    applyOpsAtomically(session, parsedOps.data)
    for (const [slug, snapshot] of snapshots) pushUndo(session, slug, snapshot)
    const firstSlugOp = parsedOps.data.find((op) => "pageSlug" in op && typeof op.pageSlug === "string")
    const firstSlug = firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string" ? firstSlugOp.pageSlug : undefined
    const updatedSlug = firstSlug ? pickUpdatedSlug(session, firstSlug, parsedOps.data) : undefined
    if (firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string") {
      pushRecentEdit(session, { slug: updatedSlug ?? firstSlugOp.pageSlug, summary: "Applied operations.", ops: parsedOps.data })
    }
    const previewVersion = bumpVersion(session)
    schedulePersistState()
    const focusBlockId = pickFocusBlockId(parsedOps.data)
    return {
      status: "applied",
      summary: "Applied operations.",
      changes: [],
      mentionedSlugs: collectMentionedSlugsFromOps(parsedOps.data, updatedSlug ?? firstSlug),
      previewVersion,
      focusBlockId,
      updatedSlug
    }
  } catch (error) {
    return reply.code(400).send({ error: toErrorDetail(error) })
  }
})

app.post("/chat", async (request, reply) => {
  const body = request.body as ChatRequestBody
  const result = await runChatPipeline(body)
  return reply.code(result.code).send(result.payload)
})

app.get("/chat/stream", async (request, reply) => {
  const query = request.query as ChatRequestBody
  const origin = request.headers.origin ?? "*"

  reply.raw.setHeader("Content-Type", "text/event-stream")
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
  reply.raw.setHeader("Connection", "keep-alive")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  reply.raw.setHeader("Access-Control-Allow-Origin", origin)
  reply.raw.setHeader("Vary", "Origin")

  reply.raw.write("retry: 60000\n\n")
  sseWrite(reply, { type: "status", message: "Crafting your update..." })
  const result = await runChatPipeline(query, {
    onPlanningToken: (token) => sseWrite(reply, { type: "token", text: token }),
    onOpApplied: (event) =>
      sseWrite(reply, {
        type: "op_applied",
        index: event.index,
        total: event.total,
        op: event.op,
        previewVersion: event.previewVersion,
        focusBlockId: event.focusBlockId ?? null
      })
  })
  if (result.code >= 400) {
    sseWrite(reply, { type: "error", result: result.payload, code: result.code })
    reply.raw.end()
    return reply
  }

  sseWrite(reply, { type: "final", result: result.payload })
  reply.raw.end()
  return reply
})

app.post("/history/undo", async (request, reply) => {
  const body = request.body as { session?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })

  const undoMap = getHistoryMap(historyUndo, body.session)
  const redoMap = getHistoryMap(historyRedo, body.session)
  const list = undoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to undo" })

  const current = getPage(body.session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const prev = list.pop()
  undoMap.set(body.slug, list)
  if (!prev) return reply.code(400).send({ error: "nothing to undo" })

  const redoList = redoMap.get(body.slug) ?? []
  redoList.push(structuredClone(current))
  redoMap.set(body.slug, redoList)

  setPage(body.session, structuredClone(prev))
  const previewVersion = bumpVersion(body.session)
  schedulePersistState()
  return { status: "applied", previewVersion }
})

app.post("/history/redo", async (request, reply) => {
  const body = request.body as { session?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })

  const undoMap = getHistoryMap(historyUndo, body.session)
  const redoMap = getHistoryMap(historyRedo, body.session)
  const list = redoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to redo" })

  const current = getPage(body.session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const next = list.pop()
  redoMap.set(body.slug, list)
  if (!next) return reply.code(400).send({ error: "nothing to redo" })

  const undoList = undoMap.get(body.slug) ?? []
  undoList.push(structuredClone(current))
  undoMap.set(body.slug, undoList)

  setPage(body.session, structuredClone(next))
  const previewVersion = bumpVersion(body.session)
  schedulePersistState()
  return { status: "applied", previewVersion }
})

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => ({
  plannerSource: process.env.OPENAI_API_KEY ? "openai" : "demo"
}))
app.get("/favicon.ico", async (_request, reply) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0f172a"/>
  <path d="M32 10l4.6 12.4L49 27l-12.4 4.6L32 44l-4.6-12.4L15 27l12.4-4.6L32 10z" fill="#f8fafc"/>
  <path d="M49 36l2.2 6 6 2.2-6 2.2-2.2 6-2.2-6-6-2.2 6-2.2 2.2-6z" fill="#67e8f9"/>
  <path d="M18 36l1.6 4.2 4.2 1.6-4.2 1.6L18 48l-1.6-4.2-4.2-1.6 4.2-1.6L18 36z" fill="#a7f3d0"/>
</svg>`
  reply
    .header("content-type", "image/svg+xml; charset=utf-8")
    .header("cache-control", "public, max-age=86400")
    .send(svg)
})

const port = Number(process.env.PORT ?? 4200)
await loadStateFromDisk()
await app.listen({ port, host: "0.0.0.0" })
app.log.info(`Orchestrator listening on ${port}`)
