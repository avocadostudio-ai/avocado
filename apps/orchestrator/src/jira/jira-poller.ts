/**
 * JIRA polling mode.
 *
 * Periodically queries JIRA via JQL to find tickets ready for processing.
 * Used when JIRA webhooks cannot be configured (firewall, permissions, etc.).
 *
 * Enabled via JIRA_POLL_ENABLED=1.
 */

import type { FastifyBaseLogger } from "fastify"
import { JiraClient } from "./jira-client.js"
import { processJiraTicket } from "./jira-processor.js"
import type { JiraConfig } from "./jira-types.js"

const processedKeys = new Set<string>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let clearTimer: ReturnType<typeof setInterval> | null = null
let isPolling = false

export function startJiraPoller(options: {
  config: JiraConfig
  generatedImageDir: string
  orchestratorPublicOrigin: string
  logger: FastifyBaseLogger
}): void {
  const { config, generatedImageDir, orchestratorPublicOrigin, logger } = options

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
      const issues = await client.searchJql(config.pollJql, 10)
      const newIssues = issues.filter((i) => !processedKeys.has(i.key))

      if (newIssues.length > 0) {
        logger.info({ count: newIssues.length, keys: newIssues.map((i) => i.key) }, "JIRA: poller found new issues")
      }

      // Process sequentially to avoid conflicts
      for (const issue of newIssues) {
        processedKeys.add(issue.key)
        try {
          await processJiraTicket({
            issueKey: issue.key,
            config,
            generatedImageDir,
            orchestratorPublicOrigin,
            logger,
          })
        } catch (err) {
          logger.error(
            { issueKey: issue.key, error: err instanceof Error ? err.message : String(err) },
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

  // Initial poll immediately
  void poll()

  // Then on interval
  pollTimer = setInterval(() => void poll(), config.pollIntervalMs)

  // Clear processed keys cache every 24 hours to prevent unbounded memory growth
  // This is safe because if an issue reappears in the query results after this window,
  // it's treated as a new/updated issue to be reprocessed
  const CLEAR_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
  clearTimer = setInterval(() => {
    const clearedCount = processedKeys.size
    processedKeys.clear()
    logger.debug({ clearedCount }, "JIRA: cleared processed keys cache")
  }, CLEAR_INTERVAL_MS)

  // Graceful shutdown
  const shutdown = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (clearTimer) {
      clearInterval(clearTimer)
      clearTimer = null
    }
    logger.info("JIRA: poller stopped")
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

export function stopJiraPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (clearTimer) {
    clearInterval(clearTimer)
    clearTimer = null
  }
}

export function getPollerStatus() {
  return {
    running: pollTimer !== null,
    processedCount: processedKeys.size,
    isPolling,
  }
}
