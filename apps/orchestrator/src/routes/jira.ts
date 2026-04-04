/**
 * JIRA integration routes:
 *   POST /jira/webhook  — receive JIRA webhook events (status change or @mention)
 *   POST /jira/process  — manually trigger processing of a ticket
 *   GET  /jira/status   — view processing queue and recent results
 *
 * Two trigger modes:
 * 1. Status transition — ticket moves to "Ready for Website Update"
 * 2. @mention — user @mentions the agent in a comment, agent processes ticket
 *    and assigns it back to the reporter/commenter with a preview link
 */

import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"
import { loadJiraConfig, type JiraWebhookPayload } from "../jira/jira-types.js"
import { processJiraTicket, getProcessingStatus } from "../jira/jira-processor.js"
import { getPollerStatus } from "../jira/jira-poller.js"
import { adfToPlainText } from "../jira/jira-processor.js"
import type { RouteContext } from "./route-context.js"

function validateWebhookSecret(provided: string | undefined, configured: string | undefined): boolean {
  if (!configured) return true // no secret configured = open
  if (!provided || provided.length !== configured.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured))
}

/**
 * Check if a comment mentions the agent (by account ID or by display name pattern).
 */
function commentMentionsAgent(comment: unknown, agentAccountId?: string): boolean {
  if (!comment) return false
  const text = typeof comment === "string" ? comment : adfToPlainText(comment)

  // Check for @mention by account ID in ADF mention nodes
  if (agentAccountId && typeof comment === "object" && comment !== null) {
    const json = JSON.stringify(comment)
    if (json.includes(agentAccountId)) return true
  }

  // Fallback: check for common agent mention patterns in text
  // e.g., @site-editor, @website-agent, etc.
  const agentMentionPatterns = [
    /@site[-_]?editor/i,
    /@website[-_]?agent/i,
    /@avocado[-_]?agent/i,
    /@ai[-_]?editor/i,
  ]
  return agentMentionPatterns.some((p) => p.test(text))
}

export async function jiraRoutes(app: FastifyInstance, ctx: RouteContext) {
  const config = loadJiraConfig()

  // ---------------------------------------------------------------------------
  // POST /jira/webhook — JIRA webhook handler
  // ---------------------------------------------------------------------------
  app.post("/jira/webhook", async (request, reply) => {
    if (!config) {
      return reply.code(503).send({ error: "JIRA integration not configured (JIRA_BASE_URL and JIRA_API_TOKEN required)" })
    }

    // Validate webhook secret
    const providedSecret = (request.headers["x-jira-webhook-secret"] as string)
      ?? (request.query as Record<string, string>).secret
    if (!validateWebhookSecret(providedSecret, config.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid webhook secret" })
    }

    const payload = request.body as JiraWebhookPayload
    if (!payload?.issue?.key) {
      return reply.code(400).send({ error: "Invalid webhook payload: missing issue key" })
    }

    const issueKey = payload.issue.key
    const webhookEvent = payload.webhookEvent ?? ""

    // ---- Trigger 1: @mention in a comment ----
    const isCommentEvent = webhookEvent === "comment_created" ||
      payload.issue_event_type_name === "issue_commented"
    if (isCommentEvent && payload.comment) {
      const isMentioned = commentMentionsAgent(payload.comment.body, config.agentAccountId)
      if (!isMentioned) {
        return reply.code(200).send({ ok: true, skipped: true, reason: "Comment does not mention agent" })
      }

      // Determine who to assign back to (the commenter or the reporter)
      const assignBackTo = payload.comment.author ?? payload.issue.fields.reporter ?? payload.user
      request.log.info({ issueKey, mentionedBy: assignBackTo?.displayName }, "JIRA webhook: @mention trigger")

      void processJiraTicket({
        issueKey,
        config,
        generatedImageDir: ctx.generatedImageDir,
        orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
        logger: request.log,
        assignBackTo: assignBackTo ?? undefined,
      })

      return reply.code(202).send({ ok: true, issueKey, trigger: "mention", queued: true })
    }

    // ---- Trigger 2: Status transition ----
    const statusChange = payload.changelog?.items?.find(
      (item) => item.field === "status"
    )
    if (statusChange) {
      const targetStatus = statusChange.toString ?? ""
      if (targetStatus.toLowerCase() !== config.triggerStatus.toLowerCase()) {
        return reply.code(200).send({
          ok: true,
          skipped: true,
          reason: `Status changed to "${targetStatus}", not "${config.triggerStatus}"`,
        })
      }

      const assignBackTo = payload.issue.fields.reporter ?? payload.user
      request.log.info({ issueKey, targetStatus }, "JIRA webhook: status trigger")

      void processJiraTicket({
        issueKey,
        config,
        generatedImageDir: ctx.generatedImageDir,
        orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
        logger: request.log,
        assignBackTo: assignBackTo ?? undefined,
      })

      return reply.code(202).send({ ok: true, issueKey, trigger: "status", queued: true })
    }

    // ---- Trigger 3: New issue created with agent as assignee ----
    if (webhookEvent === "jira:issue_created") {
      const assignee = payload.issue.fields.assignee
      if (assignee && config.agentAccountId && assignee.accountId === config.agentAccountId) {
        const assignBackTo = payload.issue.fields.reporter ?? payload.user
        request.log.info({ issueKey }, "JIRA webhook: new issue assigned to agent")

        void processJiraTicket({
          issueKey,
          config,
          generatedImageDir: ctx.generatedImageDir,
          orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
          logger: request.log,
          assignBackTo: assignBackTo ?? undefined,
        })

        return reply.code(202).send({ ok: true, issueKey, trigger: "assigned", queued: true })
      }
    }

    return reply.code(200).send({ ok: true, skipped: true, reason: "No matching trigger in webhook" })
  })

  // ---------------------------------------------------------------------------
  // POST /jira/process — manual trigger for testing or re-processing
  // ---------------------------------------------------------------------------
  app.post("/jira/process", async (request, reply) => {
    if (!config) {
      return reply.code(503).send({ error: "JIRA integration not configured (JIRA_BASE_URL and JIRA_API_TOKEN required)" })
    }

    const providedSecret = (request.headers["x-jira-webhook-secret"] as string)
      ?? (request.query as Record<string, string>).secret
    if (!validateWebhookSecret(providedSecret, config.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid webhook secret" })
    }

    const body = request.body as { issueKey?: string }
    if (!body?.issueKey?.trim()) {
      return reply.code(400).send({ error: "issueKey is required" })
    }

    const issueKey = body.issueKey.trim()
    request.log.info({ issueKey }, "JIRA manual process: starting")

    const result = await processJiraTicket({
      issueKey,
      config,
      generatedImageDir: ctx.generatedImageDir,
      orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
      logger: request.log,
    })

    return reply.code(result.status === "success" ? 200 : 500).send(result)
  })

  // ---------------------------------------------------------------------------
  // GET /jira/status — monitoring endpoint
  // ---------------------------------------------------------------------------
  app.get("/jira/status", async () => {
    const processing = getProcessingStatus()
    const poller = getPollerStatus()

    return {
      configured: config !== null,
      triggerStatus: config?.triggerStatus ?? null,
      autoPublish: config?.autoPublish ?? false,
      agentAccountId: config?.agentAccountId ?? null,
      poller,
      ...processing,
    }
  })
}
