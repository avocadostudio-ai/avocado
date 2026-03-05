import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
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
  getSessionPages
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
  return provided.length > 0 && provided === configured
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

export async function listRestoreSnapshots(limit = 30): Promise<SnapshotDescriptor[]> {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const cappedLimit = Math.max(1, Math.min(80, Math.floor(limit)))
  const rawLog = (await runGit(["log", "--max-count", String(cappedLimit * 4), "--date=iso-strict", "--pretty=format:%H|%ad|%s", "--", targetPath], repoRoot)).stdout
  const lines = rawLog
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const snapshots: SnapshotDescriptor[] = []
  for (const line of lines) {
    const first = line.indexOf("|")
    const second = line.indexOf("|", first + 1)
    if (first <= 0 || second <= first) continue
    const commit = line.slice(0, first).trim()
    const committedAt = line.slice(first + 1, second).trim()
    const message = line.slice(second + 1).trim()
    if (!commit) continue
    try {
      const pages = await loadPublishedSnapshotFromCommit(commit)
      const home = pages.find((page) => page.slug === "/")
      const homeHeadingRaw = home?.blocks.find((block) => block.type === "Hero")?.props?.heading
      const homeHeading = typeof homeHeadingRaw === "string" && homeHeadingRaw.trim().length > 0 ? homeHeadingRaw.trim() : "(no hero heading)"
      const signature = `${pages.length}::${homeHeading}::${pages.map((page) => page.slug).join("|")}`
      if (seen.has(signature)) continue
      seen.add(signature)
      snapshots.push({
        commit: commit.slice(0, 7),
        committedAt,
        message,
        pageCount: pages.length,
        homeHeading
      })
      if (snapshots.length >= cappedLimit) break
    } catch {
      // Ignore malformed/unrelated historical snapshots.
    }
  }
  return snapshots
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
  try {
    await runGit(["diff", "--cached", "--quiet", "--", targetPath], repoRoot)
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
