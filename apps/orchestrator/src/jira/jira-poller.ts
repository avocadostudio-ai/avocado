/**
 * JIRA polling mode.
 *
 * Periodically queries JIRA via JQL to find tickets that need action. Used
 * when webhooks aren't available (firewall, local dev, etc.).
 *
 * The poller inspects each matching issue and decides which processing mode
 * to run based on current status + comment history:
 *
 *   - To Do, no prior agent comment         → review (first look)
 *   - To Do, new reporter comment (approval) → execute
 *   - To Do, new reporter comment (other)   → review (re-review with new info)
 *   - In Review, new reporter comment (approval) → publish
 *   - In Review, new reporter comment (other)    → execute (apply follow-up edits)
 *
 * Deduplication key = `${issueKey}:${status}:${commentCount}`, so the poller
 * re-processes only when state meaningfully changes.
 *
 * Enabled via JIRA_POLL_ENABLED=1.
 */

import type { FastifyBaseLogger } from "fastify"
import { JiraClient } from "./jira-client.js"
import { processJiraTicket, adfToPlainText, type JiraProcessingMode } from "./jira-processor.js"
import { isApprovalComment } from "./jira-approval.js"
import type { JiraConfig, JiraIssue, JiraComment } from "./jira-types.js"

// Dedup: per-issue state fingerprint we've already processed.
const processedStates = new Map<string, string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let clearTimer: ReturnType<typeof setInterval> | null = null
let isPolling = false

function statusEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function fingerprint(issue: JiraIssue): string {
  const status = issue.fields.status?.name ?? "?"
  const commentCount = issue.fields.comment?.comments?.length ?? 0
  return `${issue.key}:${status}:${commentCount}`
}

export type PollerRoute =
  | { mode: JiraProcessingMode; reason: string }
  | null

/**
 * Decide whether an issue found by the poller needs processing right now, and
 * in which mode. Returns null when the issue should be left alone (e.g. agent
 * has already reviewed and is waiting for the reporter).
 */
export function routePollerIssue(issue: JiraIssue, config: JiraConfig): PollerRoute {
  const status = issue.fields.status?.name
  const comments = issue.fields.comment?.comments ?? []
  const agentId = config.agentAccountId

  const agentComments = comments.filter((c) => agentId && c.author?.accountId === agentId)
  const nonAgentComments = comments.filter((c) => !agentId || c.author?.accountId !== agentId)
  const latestAgent = agentComments.at(-1)
  const latestNonAgent = nonAgentComments.at(-1)

  const hasNewerReporterComment = (latestNonAgent: JiraComment | undefined) => {
    if (!latestNonAgent) return false
    if (!latestAgent) return true
    return latestNonAgent.created > latestAgent.created
  }

  const latestBodyText = (c: JiraComment | undefined): string => {
    if (!c) return ""
    return typeof c.body === "string" ? c.body : adfToPlainText(c.body)
  }

  // ---- Review stage ----
  if (statusEquals(status, config.reviewStatus) || statusEquals(status, config.triggerStatus)) {
    if (agentComments.length === 0) {
      return { mode: "review", reason: "first review — To Do ticket with no agent comment" }
    }
    if (hasNewerReporterComment(latestNonAgent)) {
      const body = latestBodyText(latestNonAgent)
      if (isApprovalComment(body)) {
        return { mode: "execute", reason: "approval comment on To Do" }
      }
      return { mode: "review", reason: "new reporter comment on To Do — re-review" }
    }
    return null
  }

  // ---- Preview stage ----
  if (statusEquals(status, config.previewStatus)) {
    if (hasNewerReporterComment(latestNonAgent)) {
      const body = latestBodyText(latestNonAgent)
      if (isApprovalComment(body)) {
        return { mode: "publish", reason: "approval comment on In Review" }
      }
      return { mode: "execute", reason: "follow-up comment on In Review — re-edit" }
    }
    return null
  }

  return null
}

export function startJiraPoller(options: {
  config: JiraConfig
  generatedImageDir: string
  orchestratorPublicOrigin: string
  sitePublicOrigin: string
  logger: FastifyBaseLogger
}): void {
  const { config, generatedImageDir, orchestratorPublicOrigin, sitePublicOrigin, logger } = options

  if (pollTimer) {
    logger.warn("JIRA poller already running, skipping duplicate start")
    return
  }

  const client = new JiraClient(config)
  logger.info(
    { jql: config.pollJql, intervalMs: config.pollIntervalMs },
    "JIRA: starting poller"
  )

  async function poll() {
    if (isPolling) return
    isPolling = true

    try {
      const issues = await client.searchJql(config.pollJql, 20)
      const actionable: Array<{ issue: JiraIssue; route: NonNullable<PollerRoute>; fp: string }> = []

      for (const issue of issues) {
        const route = routePollerIssue(issue, config)
        if (!route) continue
        const fp = fingerprint(issue)
        if (processedStates.get(issue.key) === fp) continue
        actionable.push({ issue, route, fp })
      }

      if (actionable.length > 0) {
        logger.info(
          { count: actionable.length, keys: actionable.map((a) => `${a.issue.key}(${a.route.mode})`) },
          "JIRA: poller found actionable issues"
        )
      }

      for (const { issue, route, fp } of actionable) {
        processedStates.set(issue.key, fp)
        try {
          await processJiraTicket({
            issueKey: issue.key,
            config,
            mode: route.mode,
            generatedImageDir,
            orchestratorPublicOrigin,
            sitePublicOrigin,
            logger,
          })
        } catch (err) {
          logger.error(
            { issueKey: issue.key, mode: route.mode, error: err instanceof Error ? err.message : String(err) },
            "JIRA: poller failed to process issue"
          )
        }
      }
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "JIRA: poller query failed"
      )
    } finally {
      isPolling = false
    }
  }

  void poll()
  pollTimer = setInterval(() => void poll(), config.pollIntervalMs)

  // Clear dedup cache every 24h so issues that sit in the same state for a
  // long time can still be re-picked-up if needed (e.g. after server restart
  // with stale cache).
  const CLEAR_INTERVAL_MS = 24 * 60 * 60 * 1000
  clearTimer = setInterval(() => {
    const cleared = processedStates.size
    processedStates.clear()
    logger.debug({ cleared }, "JIRA: cleared poller dedup cache")
  }, CLEAR_INTERVAL_MS)

  const shutdown = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (clearTimer) { clearInterval(clearTimer); clearTimer = null }
    logger.info("JIRA: poller stopped")
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

export function stopJiraPoller(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  if (clearTimer) { clearInterval(clearTimer); clearTimer = null }
}

export function getPollerStatus() {
  return {
    running: pollTimer !== null,
    processedCount: processedStates.size,
    isPolling,
  }
}
