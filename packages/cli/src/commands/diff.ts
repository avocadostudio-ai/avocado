import pc from "picocolors"
import { resolveConfig, type ConfigOptions } from "../config.js"
import { request } from "../http.js"
import { fail, requireSiteId, ui } from "../format.js"

type DiffOptions = ConfigOptions & {
  json?: boolean
}

type PublishDiff = {
  added?: string[]
  removed?: string[]
  changed?: Array<{ slug: string; changes?: unknown }>
  unchanged?: string[]
  [k: string]: unknown
}

export async function diffCommand(opts: DiffOptions): Promise<void> {
  const config = resolveConfig(opts)
  const siteId = requireSiteId(config.siteId)

  let diff: PublishDiff
  try {
    diff = await request<PublishDiff>(config, "/publish/diff", {
      query: {
        session: config.session,
        siteId,
        ...(config.siteOrigin ? { siteOrigin: config.siteOrigin } : {}),
      },
    })
  } catch (err) {
    fail((err as Error).message)
  }

  if (opts.json) {
    console.log(JSON.stringify(diff, null, 2))
    return
  }

  const added = diff.added ?? []
  const removed = diff.removed ?? []
  const changed = diff.changed ?? []
  const unchanged = diff.unchanged ?? []

  ui.section("Publish diff")
  ui.kv("site", siteId)
  ui.kv("session", config.session)

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    console.log()
    ui.success("No changes — draft matches published.")
    if (unchanged.length) ui.dim(`  ${unchanged.length} page(s) unchanged`)
    return
  }

  if (added.length) {
    console.log()
    console.log(pc.green(`+ Added (${added.length})`))
    for (const slug of added) console.log("    " + pc.green(slug))
  }
  if (removed.length) {
    console.log()
    console.log(pc.red(`- Removed (${removed.length})`))
    for (const slug of removed) console.log("    " + pc.red(slug))
  }
  if (changed.length) {
    console.log()
    console.log(pc.yellow(`~ Changed (${changed.length})`))
    for (const entry of changed) console.log("    " + pc.yellow(entry.slug))
  }
  if (unchanged.length) {
    console.log()
    ui.dim(`  ${unchanged.length} page(s) unchanged`)
  }
}
