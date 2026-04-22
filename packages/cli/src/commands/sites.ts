import pc from "picocolors"
import { resolveConfig, type ConfigOptions } from "../config.js"
import { request } from "../http.js"
import { fail, ui } from "../format.js"

type SitesListOptions = ConfigOptions & {
  json?: boolean
}

type SiteSummary = {
  siteId?: string
  name?: string
  previewUrl?: string
  port?: number
  purpose?: string
  [k: string]: unknown
}

type SitesResponse = { sites?: SiteSummary[] }

export async function sitesListCommand(opts: SitesListOptions): Promise<void> {
  const config = resolveConfig(opts)

  let response: SitesResponse
  try {
    response = await request<SitesResponse>(config, "/sites", {
      query: { session: config.session },
    })
  } catch (err) {
    fail((err as Error).message)
  }

  const sites = response.sites ?? []
  if (opts.json) {
    console.log(JSON.stringify(sites, null, 2))
    return
  }

  if (sites.length === 0) {
    ui.warn(`No sites registered for session "${config.session}".`)
    ui.dim("  Register one with: avc register --name \"My Site\"")
    return
  }

  ui.section(`Sites (${sites.length})`)
  for (const site of sites) {
    const id = site.siteId ?? "(unknown)"
    const name = site.name ? pc.bold(site.name) : pc.dim("(no name)")
    console.log(`  ${pc.yellow(id.padEnd(24))} ${name}`)
    if (site.previewUrl) ui.dim(`    ${site.previewUrl}`)
    if (site.purpose) ui.dim(`    ${site.purpose}`)
  }
}
