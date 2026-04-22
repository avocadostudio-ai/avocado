import { resolveConfig, type ConfigOptions } from "../config.js"
import { HttpError, request } from "../http.js"
import { fail, requireSiteId, ui } from "../format.js"

type PublishStatus = {
  status?: string
  vercelState?: string
  inspectUrl?: string
  deploymentId?: string
  url?: string
  commit?: string
  publishedAt?: string
  error?: string
  [k: string]: unknown
}

export async function statusCommand(opts: ConfigOptions): Promise<void> {
  const config = resolveConfig(opts)
  const siteId = requireSiteId(config.siteId)

  let status: PublishStatus
  try {
    status = await request<PublishStatus>(config, "/publish/status", {
      query: { session: config.session, siteId },
    })
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      ui.warn("No publish status for this session yet — nothing has been published.")
      return
    }
    fail((err as Error).message)
  }

  ui.section("Publish status")
  ui.kv("site", siteId)
  ui.kv("session", config.session)
  ui.kv("status", status.status)
  ui.kv("vercel", status.vercelState)
  ui.kv("url", status.url)
  ui.kv("inspect", status.inspectUrl)
  ui.kv("deployment", status.deploymentId)
  ui.kv("commit", status.commit ? status.commit.slice(0, 7) : undefined)
  ui.kv("publishedAt", status.publishedAt)
  if (status.error) {
    console.log()
    ui.error(status.error)
  }
}
