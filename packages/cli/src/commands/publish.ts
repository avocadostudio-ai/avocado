import pc from "picocolors"
import { resolveConfig, type ConfigOptions } from "../config.js"
import { HttpError, request } from "../http.js"
import { fail, requireSiteId, ui } from "../format.js"

type PublishOptions = ConfigOptions & {
  wait?: boolean
  timeout?: number
}

type PublishResponse = {
  status?: string
  commit?: string
  deploymentId?: string
  inspectUrl?: string
  publishedAt?: string
  [k: string]: unknown
}

type PublishStatus = {
  status?: string
  vercelState?: string
  inspectUrl?: string
  deploymentId?: string
  url?: string
  error?: string
  [k: string]: unknown
}

const TERMINAL_OK = new Set(["live", "ready", "READY"])
const TERMINAL_FAIL = new Set(["error", "failed", "ERROR"])

async function poll(
  orchestrator: string,
  session: string,
  siteId: string,
  timeoutSec: number,
): Promise<PublishStatus> {
  const deadline = Date.now() + timeoutSec * 1000
  let last: PublishStatus = {}
  let spinFrame = 0
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const isTTY = Boolean(process.stdout.isTTY)
  const clearSpinner = () => {
    if (isTTY) process.stdout.write("\r\x1b[K")
  }

  while (Date.now() < deadline) {
    try {
      last = await request<PublishStatus>(
        { orchestrator, session, siteId },
        "/publish/status",
        { query: { session, siteId } },
      )
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        // status not ready yet
      } else {
        throw err
      }
    }

    const state = last.vercelState ?? last.status ?? ""
    const label = last.status ?? last.vercelState ?? "pending"
    if (isTTY) {
      process.stdout.write(`\r  ${pc.cyan(frames[spinFrame++ % frames.length])} ${pc.dim(label)}  `)
    } else {
      process.stdout.write(`  ${label}\n`)
    }

    if (TERMINAL_OK.has(state)) {
      clearSpinner()
      return last
    }
    if (TERMINAL_FAIL.has(state)) {
      clearSpinner()
      throw new Error(last.error ?? `publish failed: ${state}`)
    }

    await new Promise((r) => setTimeout(r, 2000))
  }
  clearSpinner()
  throw new Error(`Timed out after ${timeoutSec}s waiting for publish to go live`)
}

export async function publishCommand(opts: PublishOptions): Promise<void> {
  const config = resolveConfig(opts)
  const siteId = requireSiteId(config.siteId)

  ui.section("Publishing")
  ui.kv("site", siteId)
  ui.kv("session", config.session)
  ui.kv("orchestrator", config.orchestrator)
  if (config.siteOrigin) ui.kv("siteOrigin", config.siteOrigin)

  let response: PublishResponse
  try {
    response = await request<PublishResponse>(config, "/publish", {
      method: "POST",
      includePublishToken: true,
      body: {
        session: config.session,
        siteId,
        ...(config.siteOrigin ? { siteOrigin: config.siteOrigin } : {}),
      },
      timeoutMs: 60_000,
    })
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) fail("Orchestrator rejected the publish token.", "Set PUBLISH_TOKEN or pass --token.")
      fail(`Publish request failed (${err.status}).`, err.body.slice(0, 500))
    }
    fail((err as Error).message)
  }

  ui.section("Submitted")
  ui.kv("status", response.status ?? "queued")
  if (response.commit) ui.kv("commit", response.commit.slice(0, 7))
  if (response.deploymentId) ui.kv("deployment", response.deploymentId)
  if (response.inspectUrl) ui.kv("inspect", response.inspectUrl)

  if (!opts.wait) {
    console.log()
    ui.dim("Run `avc status` to check progress, or re-run with --wait to block until live.")
    return
  }

  ui.section("Waiting for deployment")
  let finalStatus: PublishStatus
  try {
    finalStatus = await poll(config.orchestrator, config.session, siteId, opts.timeout ?? 120)
  } catch (err) {
    fail((err as Error).message)
  }

  ui.success("Site is live")
  if (finalStatus.url) ui.kv("url", finalStatus.url)
  if (finalStatus.inspectUrl) ui.kv("inspect", finalStatus.inspectUrl)
  if (finalStatus.deploymentId) ui.kv("deployment", finalStatus.deploymentId)
}
