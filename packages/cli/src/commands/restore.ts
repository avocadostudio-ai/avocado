import pc from "picocolors"
import { resolveConfig, type ConfigOptions } from "../config.js"
import { request } from "../http.js"
import { fail, requireSiteId, ui } from "../format.js"

type RestoreListOptions = ConfigOptions & {
  limit?: number
  json?: boolean
}

type RestoreOptions = ConfigOptions & {
  commit?: string
  yes?: boolean
}

type Snapshot = {
  commit: string
  committedAt?: string
  message?: string
  pageCount?: number
  homeHeading?: string
}

type SnapshotsResponse = { snapshots?: Snapshot[] }

type RestoreResponse = {
  status?: string
  commit?: string
  slugs?: string[]
  previewVersion?: number
}

export function formatRelative(iso?: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ""
  const deltaSec = (Date.now() - then) / 1000
  if (deltaSec < 60) return "just now"
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`
  if (deltaSec < 86_400) return `${Math.round(deltaSec / 3600)}h ago`
  return `${Math.round(deltaSec / 86_400)}d ago`
}

export async function restoreListCommand(opts: RestoreListOptions): Promise<void> {
  const config = resolveConfig(opts)
  const siteId = config.siteId

  let response: SnapshotsResponse
  try {
    response = await request<SnapshotsResponse>(config, "/restore/snapshots", {
      query: { limit: opts.limit ?? 30, siteId },
    })
  } catch (err) {
    fail((err as Error).message)
  }

  const snapshots = response.snapshots ?? []
  if (opts.json) {
    console.log(JSON.stringify(snapshots, null, 2))
    return
  }

  if (snapshots.length === 0) {
    ui.warn("No snapshots found." + (siteId ? ` (filtered by site=${siteId})` : ""))
    return
  }

  ui.section(`Snapshots (${snapshots.length})`)
  for (const snap of snapshots) {
    const when = formatRelative(snap.committedAt).padEnd(10)
    const pages = snap.pageCount !== undefined ? `${snap.pageCount} page${snap.pageCount === 1 ? "" : "s"}` : ""
    const heading = snap.homeHeading ? ` — ${pc.dim(snap.homeHeading)}` : ""
    console.log(
      `  ${pc.yellow(snap.commit.slice(0, 7))}  ${pc.dim(when)}  ${pages.padEnd(10)}${heading}`,
    )
  }
  console.log()
  ui.dim("Roll back with: avc restore --commit <sha>")
}

export async function restoreCommand(opts: RestoreOptions): Promise<void> {
  const config = resolveConfig(opts)
  const siteId = requireSiteId(config.siteId)

  const commit = (opts.commit ?? "").trim()
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    fail("--commit is required (7–40 hex chars).")
  }

  ui.section("Restoring snapshot")
  ui.kv("site", siteId)
  ui.kv("session", config.session)
  ui.kv("commit", commit.slice(0, 7))

  let result: RestoreResponse
  try {
    result = await request<RestoreResponse>(config, "/restore/snapshot", {
      method: "POST",
      body: { commit, session: config.session, siteId },
    })
  } catch (err) {
    fail((err as Error).message)
  }

  ui.success(`Restored to ${result.commit ?? commit.slice(0, 7)}`)
  if (result.slugs?.length) ui.kv("pages", `${result.slugs.length}`)
  console.log()
  ui.dim("The draft now reflects the restored snapshot. Run `avc diff` to review, then `avc publish` to make it live.")
}
