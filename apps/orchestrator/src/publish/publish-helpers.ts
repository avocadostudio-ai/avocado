import { timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import type { FastifyBaseLogger } from "fastify"
import { pageDocSchema, type PageDoc } from "@ai-site-editor/shared"
import {
  type PublishTracker,
  draftPages,
  versions,
  ensureHeroImageProps,
  persistStateNow,
  getSessionPages,
  getSiteConfig,
  isLegacySiteId
} from "../state/session-state.js"
import { toErrorDetail } from "../ops/ops-engine.js"

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Logger interface for functions that need structured logging
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Deployment helpers
// ---------------------------------------------------------------------------

export function deploymentIdFromAny(input: string): string | undefined {
  const match = input.match(/\b(dpl_[a-zA-Z0-9]+)\b/)
  return match?.[1]
}

export async function refreshPublishStatusFromVercel(current: PublishTracker) {
  const token = process.env.VERCEL_TOKEN?.trim()
  if (!token || !current.deploymentId) {
    // Can't poll Vercel API — auto-resolve after a grace period so the UI
    // doesn't spin forever.  Default 120 s (typical Vercel build time).
    const graceSec = Number(process.env.PUBLISH_GRACE_SECONDS) || 120
    const elapsed = current.startedAt
      ? (Date.now() - new Date(current.startedAt).getTime()) / 1000
      : Infinity
    if (elapsed >= graceSec && current.status === "triggered") {
      current.vercelState = "READY"
      current.status = "triggered"
      current.updatedAt = new Date().toISOString()
    }
    return current
  }

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
    const data = (await res.json()) as { readyState?: string; inspectorUrl?: string }
    const state = typeof data.readyState === "string" ? data.readyState : "UNKNOWN"
    current.vercelState = state
    current.inspectUrl = typeof data.inspectorUrl === "string" ? data.inspectorUrl : current.inspectUrl
    current.lastCheckError = undefined
    current.updatedAt = new Date().toISOString()
  } catch {
    current.lastCheckError = "fetch_error"
    current.updatedAt = new Date().toISOString()
  }
  return current
}

export function requirePublishToken(request: { headers: Record<string, unknown> }) {
  const configured = process.env.PUBLISH_TOKEN?.trim()
  if (!configured) return true
  const provided = String(request.headers["x-publish-token"] ?? "").trim()
  if (provided.length === 0 || provided.length !== configured.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured))
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

async function runGit(args: string[], cwd: string) {
  try {
    const result = await execFileAsync("git", args, { cwd })
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string }
    const stderr = (maybe.stderr ?? "").trim()
    const stdout = (maybe.stdout ?? "").trim()
    const message = (maybe.message ?? "").trim()
    const detail = stderr || stdout || message || toErrorDetail(error)
    throw new Error(detail)
  }
}

// ---------------------------------------------------------------------------
// Snapshot restore
// ---------------------------------------------------------------------------

export type SnapshotDescriptor = {
  commit: string
  committedAt: string
  message: string
  pageCount: number
  homeHeading: string
}

const RESTORE_SESSION_PRESETS: Array<{ sessionKey: string; commit: string }> = [
  { sessionKey: "adventure-arena::dev", commit: "70584e0" },
  { sessionKey: "avocado-magic::dev", commit: "269c0be" },
  { sessionKey: "avocado-odyssey::dev", commit: "69eab10" }
]

export async function loadPublishedSnapshotFromCommit(commit: string): Promise<PageDoc[]> {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const raw = (await runGit(["show", `${commit}:${targetPath}`], repoRoot)).stdout
  const payload = JSON.parse(raw) as unknown
  if (!Array.isArray(payload)) throw new Error("snapshot payload is not an array")

  const pages: PageDoc[] = []
  for (const candidate of payload) {
    const parsed = pageDocSchema.safeParse(candidate)
    if (!parsed.success) throw new Error("snapshot payload contains invalid page schema")
    pages.push(parsed.data)
  }
  if (pages.length === 0) throw new Error("snapshot has no pages")
  return pages
}

// In-memory cache: full commit hash → descriptor (snapshots are immutable)
const snapshotDescriptorCache = new Map<string, { descriptor: SnapshotDescriptor; signature: string } | null>()

type ParsedCommitLine = { commit: string; committedAt: string; message: string }

function parseCommitLine(line: string): ParsedCommitLine | null {
  const first = line.indexOf("|")
  const second = line.indexOf("|", first + 1)
  if (first <= 0 || second <= first) return null
  const commit = line.slice(0, first).trim()
  const committedAt = line.slice(first + 1, second).trim()
  const message = line.slice(second + 1).trim()
  if (!commit) return null
  return { commit, committedAt, message }
}

async function resolveCommitDescriptor(parsed: ParsedCommitLine): Promise<{ descriptor: SnapshotDescriptor; signature: string } | null> {
  const cached = snapshotDescriptorCache.get(parsed.commit)
  if (cached !== undefined) return cached

  try {
    const pages = await loadPublishedSnapshotFromCommit(parsed.commit)
    const home = pages.find((page) => page.slug === "/")
    const homeHeadingRaw = home?.blocks.find((block) => block.type === "Hero")?.props?.heading
    const homeHeading = typeof homeHeadingRaw === "string" && homeHeadingRaw.trim().length > 0 ? homeHeadingRaw.trim() : "(no hero heading)"
    const signature = `${pages.length}::${homeHeading}::${pages.map((page) => page.slug).join("|")}`
    const result = {
      descriptor: {
        commit: parsed.commit.slice(0, 7),
        committedAt: parsed.committedAt,
        message: parsed.message,
        pageCount: pages.length,
        homeHeading
      },
      signature
    }
    snapshotDescriptorCache.set(parsed.commit, result)
    return result
  } catch {
    snapshotDescriptorCache.set(parsed.commit, null)
    return null
  }
}

export async function listRestoreSnapshots(limit = 30, siteId?: string): Promise<SnapshotDescriptor[]> {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const cappedLimit = Math.max(1, Math.min(80, Math.floor(limit)))
  const gitArgs = ["log", "--max-count", String(cappedLimit * 4), "--date=iso-strict", "--pretty=format:%H|%ad|%s"]
  if (siteId) {
    const normalised = siteId.trim().toLowerCase()
    if (isLegacySiteId(normalised)) {
      // Legacy commits use bare session key: "publish: session dev ..."
      // The trailing space ensures we don't match scoped keys like "siteId::dev"
      gitArgs.push("--grep=publish: session dev ")
    } else {
      gitArgs.push(`--grep=publish: session ${normalised}::`)
    }
  }
  gitArgs.push("--", targetPath)
  const rawLog = (await runGit(gitArgs, repoRoot)).stdout
  const parsedLines = rawLog
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseCommitLine)
    .filter((p): p is ParsedCommitLine => p !== null)

  const seen = new Set<string>()
  const snapshots: SnapshotDescriptor[] = []
  const CONCURRENCY = 5

  for (let i = 0; i < parsedLines.length && snapshots.length < cappedLimit; i += CONCURRENCY) {
    const batch = parsedLines.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(resolveCommitDescriptor))
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue
      const { descriptor, signature } = result.value
      if (seen.has(signature)) continue
      seen.add(signature)
      snapshots.push(descriptor)
      if (snapshots.length >= cappedLimit) break
    }
  }
  return snapshots
}

/**
 * Delete a publish snapshot by reverting its git commit.
 * Uses `git revert --no-commit` + `git commit` to keep history linear.
 * Returns true if the revert succeeded, false otherwise.
 */
export async function deletePublishSnapshot(commit: string): Promise<boolean> {
  const repoRoot = resolve(process.cwd(), "../..")
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return false
  try {
    // Resolve short hash to full hash
    const fullHash = (await runGit(["rev-parse", commit], repoRoot)).stdout.trim()
    // Revert without auto-commit, then commit with a descriptive message
    await runGit(["revert", "--no-commit", fullHash], repoRoot)
    await runGit(["commit", "-m", `revert publish snapshot ${commit}`], repoRoot)
    // Invalidate cache for this commit
    snapshotDescriptorCache.delete(fullHash)
    return true
  } catch {
    // Reset any partial revert state
    try { await runGit(["revert", "--abort"], repoRoot) } catch { /* ignore */ }
    return false
  }
}

export function isTemplateFallbackSession(sessionDraft: Map<string, PageDoc>) {
  const slugs = Array.from(sessionDraft.keys())
  if (!(slugs.length === 1 || slugs.length === 2)) return false
  const home = sessionDraft.get("/")
  if (!home) return false
  const heroHeading = home.blocks.find((block) => block.type === "Hero")?.props?.heading
  return heroHeading === "Build websites with plain language"
}

export async function ensurePresetRestoreSessions(log: FastifyBaseLogger) {
  let changed = false
  for (const preset of RESTORE_SESSION_PRESETS) {
    const existing = draftPages.get(preset.sessionKey)
    if (existing && !isTemplateFallbackSession(existing)) continue

    try {
      const pages = await loadPublishedSnapshotFromCommit(preset.commit)
      const seeded = new Map<string, PageDoc>()
      for (const page of pages) {
        const clone = structuredClone(page)
        ensureHeroImageProps(clone)
        seeded.set(clone.slug, clone)
      }
      draftPages.set(preset.sessionKey, seeded)
      versions.set(preset.sessionKey, Math.max(1, versions.get(preset.sessionKey) ?? 0))
      changed = true
      log.info({ session: preset.sessionKey, commit: preset.commit }, "Seeded preset restore session")
    } catch (error) {
      log.warn({ session: preset.sessionKey, commit: preset.commit, err: toErrorDetail(error) }, "Failed to seed preset restore session")
    }
  }
  if (changed) await persistStateNow(log)
}

// ---------------------------------------------------------------------------
// Image URL rewriting for publish
// ---------------------------------------------------------------------------

const LOCALHOST_GENERATED_RE =
  /https?:\/\/localhost:\d+\/generated-images\/([a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp|gif))/gi

const LOCALHOST_GDRIVE_RE =
  /https?:\/\/localhost:\d+\/gdrive\/images\/([a-zA-Z0-9_-]+)/gi

export function findLocalhostImageUrls(pages: PageDoc[]): Map<string, string> {
  const json = JSON.stringify(pages)
  const urlMap = new Map<string, string>()
  for (const match of json.matchAll(LOCALHOST_GENERATED_RE)) {
    urlMap.set(match[0], match[1])
  }
  for (const match of json.matchAll(LOCALHOST_GDRIVE_RE)) {
    urlMap.set(match[0], `gdrive_${match[1]}.webp`)
  }
  return urlMap
}

function rewriteImageUrlsInPages(pages: PageDoc[], urlMap: Map<string, string>): PageDoc[] {
  let json = JSON.stringify(pages)
  for (const [originalUrl, fileName] of urlMap) {
    json = json.replaceAll(originalUrl, `/generated-images/${fileName}`)
  }
  return JSON.parse(json) as PageDoc[]
}

// ---------------------------------------------------------------------------
// Inline assets for site-contract publish (base64-encoded generated images)
// ---------------------------------------------------------------------------

export type InlineAsset = {
  /** base64-encoded image bytes */
  data: string
  /** MIME type, e.g. "image/png" */
  mimeType: string
  /** Original filename */
  fileName: string
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

/**
 * Collect generated/gdrive images referenced by localhost URLs in pages,
 * read them from disk, and return a map of originalUrl → base64 InlineAsset.
 * Missing files are silently skipped.
 */
export async function collectInlineAssets(
  pages: PageDoc[],
  generatedImageDir: string
): Promise<Record<string, InlineAsset>> {
  const urlMap = findLocalhostImageUrls(pages)
  if (urlMap.size === 0) return {}

  const entries = Array.from(urlMap.entries())
  const results = await Promise.allSettled(
    entries.map(async ([originalUrl, fileName]) => {
      const bytes = await readFile(resolve(generatedImageDir, fileName))
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "png"
      return [originalUrl, { data: bytes.toString("base64"), mimeType: MIME_BY_EXT[ext] ?? "image/png", fileName }] as const
    })
  )
  const assets: Record<string, InlineAsset> = {}
  for (const r of results) {
    if (r.status === "fulfilled") assets[r.value[0]] = r.value[1]
  }
  return assets
}

/**
 * Record a publish snapshot in git history (commit only, no push).
 * Used after site-contract publishes so version history can find them.
 * Best-effort: failures are silently ignored.
 */
export async function recordPublishSnapshot(
  session: string,
  pages: PageDoc[],
  log?: FastifyBaseLogger,
  siteConfig?: Record<string, unknown>
): Promise<string | undefined> {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const absoluteTargetPath = resolve(repoRoot, targetPath)
  try {
    // The site's publish handler is responsible for rewriting image URLs
    // and saving assets. We just commit whatever state is on disk.
    const cfg = siteConfig ?? getSiteConfig(session)
    const payload = `${JSON.stringify({ pages, siteConfig: cfg }, null, 2)}\n`
    await writeFile(absoluteTargetPath, payload, "utf8")
    await runGit(["add", targetPath], repoRoot)

    // Also stage generated images if the site handler wrote them
    const imageDir = resolve(repoRoot, "apps/site/public/generated-images")
    if (existsSync(imageDir)) {
      await runGit(["add", "apps/site/public/generated-images"], repoRoot)
    }

    // Check if there are staged changes
    try {
      await runGit(["diff", "--cached", "--quiet"], repoRoot)
      log?.info({ session }, "recordPublishSnapshot: no content changes to commit")
      return undefined // no changes
    } catch {
      // Has staged changes — commit them
    }
    const commitMessage = `publish: session ${session} ${new Date().toISOString()}`
    await runGit(["commit", "-m", commitMessage], repoRoot)
    const rev = await runGit(["rev-parse", "HEAD"], repoRoot)
    const commitSha = rev.stdout.trim()
    log?.info({ session, commitSha: commitSha.slice(0, 12) }, "recordPublishSnapshot: committed")

    // Push to remote so the commit is durable and visible
    const branch = sanitizeBranch(process.env.PUBLISH_GIT_BRANCH ?? "main")
    try {
      await runGit(["push", "origin", `HEAD:${branch}`], repoRoot)
      log?.info({ session, branch }, "recordPublishSnapshot: pushed to remote")
    } catch (pushErr) {
      log?.warn({ err: toErrorDetail(pushErr), branch }, "recordPublishSnapshot: push failed (commit exists locally)")
    }

    return commitSha
  } catch (err) {
    log?.warn({ err: toErrorDetail(err), session }, "recordPublishSnapshot: failed to record snapshot")
    return undefined
  }
}

function sanitizeBranch(input: string) {
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : "main"
}

export async function publishViaGit(session: string) {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const absoluteTargetPath = resolve(repoRoot, targetPath)
  const branch = sanitizeBranch(process.env.PUBLISH_GIT_BRANCH ?? "main")
  const strict = process.env.PUBLISH_GIT_STRICT === "1"
  let pages = getSessionPages(session)
  const slugs = pages.map((page) => page.slug)

  // Rewrite localhost image URLs → relative paths and copy files into public/
  const imageUrlMap = findLocalhostImageUrls(pages)
  const imageDestDir = resolve(repoRoot, "apps/site/public/generated-images")
  let copiedImages = false
  if (imageUrlMap.size > 0) {
    const generatedImageDir =
      process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ??
      resolve(process.cwd(), "../../.data/generated-images")
    await mkdir(imageDestDir, { recursive: true })
    for (const [, fileName] of imageUrlMap) {
      const src = resolve(generatedImageDir, fileName)
      const dest = resolve(imageDestDir, fileName)
      try {
        await copyFile(src, dest)
        copiedImages = true
      } catch {
        // Source file missing — still rewrite URL (relative 404 > unreachable localhost)
      }
    }
    pages = rewriteImageUrlsInPages(pages, imageUrlMap)
  }

  const siteConfig = getSiteConfig(session)
  const payload = `${JSON.stringify({ pages, siteConfig }, null, 2)}\n`
  await writeFile(absoluteTargetPath, payload, "utf8")

  const statusRaw = await runGit(["status", "--porcelain"], repoRoot)
  const statusLines = statusRaw.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (strict) {
    const allowedPrefixes = [targetPath, "apps/site/public/generated-images/"]
    const blocking = statusLines.filter((line) => {
      const filePart = line.slice(3) // strip status prefix (e.g. " M " or "?? ")
      return !allowedPrefixes.some((prefix) => filePart.startsWith(prefix))
    })
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

  const addPaths = [targetPath]
  if (copiedImages) addPaths.push("apps/site/public/generated-images")
  await runGit(["add", ...addPaths], repoRoot)
  try {
    await runGit(["diff", "--cached", "--quiet"], repoRoot)
    return {
      status: "ready" as const,
      session,
      slugs,
      branch,
      message: "No content changes to publish."
    }
  } catch {
    // Expected when there are staged changes for targetPath.
  }

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
    // Push current HEAD to the configured remote branch so publish works
    // even when orchestrator runs from a non-main local branch.
    await runGit(["push", "origin", `HEAD:${branch}`], repoRoot)
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

// ---------------------------------------------------------------------------
// PublishTarget interface & default implementation
// ---------------------------------------------------------------------------
export type { PublishTarget, PublishResult, PublishStatus } from "./publish-target.js"
export { GitVercelPublishTarget } from "./git-vercel-publish-target.js"
