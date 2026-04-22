import pc from "picocolors"
import { resolveConfig, type ConfigOptions } from "../config.js"
import { ui } from "../format.js"

type HealthOptions = ConfigOptions & {
  editor?: string
  siteUrl?: string
}

type Target = { label: string; url: string }

async function probe(target: Target): Promise<{ ok: boolean; detail: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 3_000)
  try {
    const res = await fetch(target.url, { signal: ac.signal })
    return { ok: res.ok, detail: `${res.status} ${res.statusText}`.trim() }
  } catch (err) {
    const aborted = (err as Error).name === "AbortError"
    return { ok: false, detail: aborted ? "timeout" : (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function healthCommand(opts: HealthOptions): Promise<void> {
  const config = resolveConfig(opts)

  const editorUrl = (
    opts.editor ??
    process.env.NEXT_PUBLIC_EDITOR_ORIGIN ??
    "http://localhost:4100"
  ).replace(/\/+$/, "")
  const siteUrl = (opts.siteUrl ?? config.siteOrigin ?? "http://localhost:3000").replace(/\/+$/, "")

  const targets: Target[] = [
    { label: "orchestrator", url: `${config.orchestrator}/health` },
    { label: "editor",       url: editorUrl },
    { label: "site",         url: siteUrl },
  ]

  ui.section("Health check")
  const results = await Promise.all(targets.map(async (t) => ({ target: t, ...(await probe(t)) })))

  for (const row of results) {
    const mark = row.ok ? pc.green("✓") : pc.red("✗")
    console.log(`  ${mark} ${row.target.label.padEnd(14)} ${pc.dim(row.target.url)}  ${row.ok ? pc.dim(row.detail) : pc.red(row.detail)}`)
  }

  const downCount = results.filter((r) => !r.ok).length
  if (downCount > 0) {
    console.log()
    ui.warn(`${downCount} service${downCount === 1 ? "" : "s"} unreachable.`)
    process.exit(1)
  }
}
