/**
 * JIRA integration routes:
 *   POST /jira/webhook  — receive JIRA webhook events (status change, comment, new issue)
 *   POST /jira/process  — manually trigger processing of a ticket
 *   GET  /jira/status   — view processing queue and recent results
 *
 * The dispatcher is state-aware. Based on the ticket's current status and the
 * incoming event, it decides which processor mode to run:
 *   - review:  agent reviews the ticket, posts a plan or questions, no changes
 *   - execute: agent applies edits, transitions to preview
 *   - publish: publish the draft, transition to done
 */

import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { FastifyInstance } from "fastify"
import { loadJiraConfig, type JiraConfig, type JiraWebhookPayload, type JiraUser } from "../jira/jira-types.js"
import { processJiraTicket, getProcessingStatus, adfToPlainText, isAgentAuthoredComment, type JiraProcessingMode } from "../jira/jira-processor.js"
import { getPollerStatus } from "../jira/jira-poller.js"
import { isApprovalComment } from "../jira/jira-approval.js"
import type { RouteContext } from "./route-context.js"

function validateWebhookSecret(provided: string | undefined, configured: string | undefined): boolean {
  if (!configured) return true // no secret configured = open
  if (!provided) return false
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(configured))
  } catch {
    return false
  }
}

/**
 * Check if an ADF node or its descendants contain a mention with the given account ID.
 */
function containsMentionByAccountId(node: unknown, accountId: string): boolean {
  if (!node || typeof node !== "object") return false
  const obj = node as Record<string, unknown>
  if (obj.type === "mention" && typeof obj.attrs === "object" && obj.attrs !== null) {
    const attrs = obj.attrs as Record<string, unknown>
    if (attrs.id === accountId) return true
  }
  if (Array.isArray(obj.content)) {
    return obj.content.some((child) => containsMentionByAccountId(child, accountId))
  }
  return false
}

function commentMentionsAgent(comment: unknown, agentAccountId?: string): boolean {
  if (!comment) return false
  const text = typeof comment === "string" ? comment : adfToPlainText(comment)
  if (agentAccountId && typeof comment === "object" && comment !== null) {
    if (containsMentionByAccountId(comment, agentAccountId)) return true
  }
  const agentMentionPatterns = [
    /@site[-_]?editor/i,
    /@website[-_]?agent/i,
    /@avocado[-_]?agent/i,
    /@ai[-_]?editor/i,
  ]
  return agentMentionPatterns.some((p) => p.test(text))
}

function statusEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Webhook routing
// ---------------------------------------------------------------------------

export type WebhookRoute =
  | { action: "process"; mode: JiraProcessingMode; reason: string; assignBackTo?: JiraUser }
  | { action: "skip"; reason: string }

/**
 * Decide what to do with an incoming webhook payload based on the ticket's
 * current status + event type + comment content. Pure function — no I/O — so
 * it's easy to test.
 *
 * Agent-authored comments and agent-triggered status changes are always
 * skipped to prevent feedback loops.
 */
export function routeWebhook(payload: JiraWebhookPayload, config: JiraConfig): WebhookRoute {
  if (!payload?.issue?.key) return { action: "skip", reason: "no issue key" }

  const webhookEvent = payload.webhookEvent ?? ""
  const currentStatus = payload.issue.fields?.status?.name
  const agentId = config.agentAccountId

  // ---- Comment events ----
  const isCommentEvent = webhookEvent === "comment_created"
    || webhookEvent === "comment_updated"
    || payload.issue_event_type_name === "issue_commented"

  if (isCommentEvent && payload.comment) {
    const authorId = payload.comment.author?.accountId
    const bodyText = typeof payload.comment.body === "string"
      ? payload.comment.body
      : adfToPlainText(payload.comment.body)
    // Classify by body shape as well as accountId so reporter replies in
    // solo tenants (same account as the agent) aren't dropped as self-loops.
    if (isAgentAuthoredComment(bodyText, authorId, agentId)) {
      return { action: "skip", reason: "comment is from agent (self-loop guard)" }
    }
    const approval = isApprovalComment(bodyText)

    if (statusEquals(currentStatus, config.reviewStatus) || statusEquals(currentStatus, config.triggerStatus)) {
      const assignBackTo = payload.comment.author ?? payload.issue.fields.reporter ?? payload.user
      if (approval) {
        return { action: "process", mode: "execute", reason: "approval comment on review-stage ticket", assignBackTo: assignBackTo ?? undefined }
      }
      // Non-approval comment from reporter on a To-Do ticket → re-review
      // with the new information, unless the comment is really just a short
      // acknowledgement that doesn't change the task.
      return { action: "process", mode: "review", reason: "new comment on review-stage ticket", assignBackTo: assignBackTo ?? undefined }
    }

    if (statusEquals(currentStatus, config.previewStatus)) {
      const assignBackTo = payload.comment.author ?? payload.issue.fields.reporter ?? payload.user
      if (approval) {
        return { action: "process", mode: "publish", reason: "approval comment on preview-stage ticket", assignBackTo: assignBackTo ?? undefined }
      }
      // Non-approval on In Review = reporter requesting more edits. Re-run
      // execute with the new comment in ticket history.
      return { action: "process", mode: "execute", reason: "follow-up comment on preview-stage ticket", assignBackTo: assignBackTo ?? undefined }
    }

    // Status doesn't match a managed state — only respond to explicit mentions
    if (commentMentionsAgent(payload.comment.body, agentId)) {
      const assignBackTo = payload.comment.author ?? payload.issue.fields.reporter ?? payload.user
      return { action: "process", mode: "review", reason: "mention in comment", assignBackTo: assignBackTo ?? undefined }
    }
    return { action: "skip", reason: "comment does not mention agent and status is not managed" }
  }

  // ---- Status-change events ----
  const statusChange = payload.changelog?.items?.find((item) => item.field === "status")
  if (statusChange) {
    const actorId = payload.user?.accountId
    if (agentId && actorId === agentId) {
      return { action: "skip", reason: "status change authored by agent (self-loop guard)" }
    }
    const targetStatus = statusChange.toString ?? ""
    const assignBackTo = payload.issue.fields.reporter ?? payload.user

    if (statusEquals(targetStatus, config.reviewStatus) || statusEquals(targetStatus, config.triggerStatus)) {
      return { action: "process", mode: "review", reason: "transitioned to review status", assignBackTo: assignBackTo ?? undefined }
    }
    if (statusEquals(targetStatus, config.executeStatus)) {
      return { action: "process", mode: "execute", reason: "manually moved to execute status", assignBackTo: assignBackTo ?? undefined }
    }
    // Preview / Done / anything else — no automatic action.
    return { action: "skip", reason: `status change to "${targetStatus}" does not trigger processing` }
  }

  // ---- Issue created ----
  if (webhookEvent === "jira:issue_created") {
    const assignee = payload.issue.fields.assignee
    if (assignee && agentId && assignee.accountId === agentId) {
      const assignBackTo = payload.issue.fields.reporter ?? payload.user
      return { action: "process", mode: "review", reason: "new issue assigned to agent", assignBackTo: assignBackTo ?? undefined }
    }
    // Also auto-review fresh tickets that land directly in the review status.
    if (statusEquals(currentStatus, config.reviewStatus) || statusEquals(currentStatus, config.triggerStatus)) {
      const assignBackTo = payload.issue.fields.reporter ?? payload.user
      return { action: "process", mode: "review", reason: "new issue in review status", assignBackTo: assignBackTo ?? undefined }
    }
  }

  return { action: "skip", reason: "no matching trigger" }
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const jiraWebhookBodySchema = z.object({
  webhookEvent: z.string().optional(),
  issue_event_type_name: z.string().optional(),
  timestamp: z.number().optional(),
  issue: z.object({ key: z.string().optional() }).passthrough().optional(),
  comment: z.unknown().optional(),
  changelog: z.unknown().optional(),
  user: z.unknown().optional(),
}).passthrough()

const jiraProcessBodySchema = z.object({
  issueKey: z.string().optional(),
  mode: z.enum(["review", "execute", "publish"]).optional(),
})

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function jiraRoutes(app: FastifyInstance, ctx: RouteContext) {
  const config = loadJiraConfig()

  app.post("/jira/webhook", async (request, reply) => {
    if (!config) {
      return reply.code(503).send({ error: "JIRA integration not configured (JIRA_BASE_URL and JIRA_API_TOKEN required)" })
    }

    const providedSecret = (request.headers["x-jira-webhook-secret"] as string)
      ?? (request.query as Record<string, string>).secret
    if (!validateWebhookSecret(providedSecret, config.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid webhook secret" })
    }

    const parsedPayload = jiraWebhookBodySchema.safeParse(request.body)
    if (!parsedPayload.success) {
      return reply.code(400).send({ error: "Invalid webhook payload", details: parsedPayload.error.issues })
    }
    const payload = parsedPayload.data as unknown as JiraWebhookPayload
    if (!payload?.issue?.key) {
      return reply.code(400).send({ error: "Invalid webhook payload: missing issue key" })
    }

    const route = routeWebhook(payload, config)
    const issueKey = payload.issue.key

    if (route.action === "skip") {
      request.log.info({ issueKey, reason: route.reason }, "JIRA webhook: skipped")
      return reply.code(200).send({ ok: true, skipped: true, reason: route.reason })
    }

    request.log.info({ issueKey, mode: route.mode, reason: route.reason }, "JIRA webhook: dispatching")
    void processJiraTicket({
      issueKey,
      config,
      mode: route.mode,
      generatedImageDir: ctx.generatedImageDir,
      orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
      sitePublicOrigin: ctx.sitePublicOrigin,
      logger: request.log,
      assignBackTo: route.assignBackTo,
    })

    return reply.code(202).send({ ok: true, issueKey, mode: route.mode, queued: true })
  })

  // ---------------------------------------------------------------------------
  // POST /jira/process — manual trigger (useful for testing + re-runs)
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

    const parsedBody = jiraProcessBodySchema.safeParse(request.body)
    if (!parsedBody.success) {
      return reply.code(400).send({ error: "invalid request body", details: parsedBody.error.issues })
    }
    const body = parsedBody.data
    if (!body?.issueKey?.trim()) {
      return reply.code(400).send({ error: "issueKey is required" })
    }

    const issueKey = body.issueKey.trim()
    const mode: JiraProcessingMode = body.mode ?? "review"
    request.log.info({ issueKey, mode }, "JIRA manual process: starting")

    const result = await processJiraTicket({
      issueKey,
      config,
      mode,
      generatedImageDir: ctx.generatedImageDir,
      orchestratorPublicOrigin: ctx.orchestratorPublicOrigin,
      sitePublicOrigin: ctx.sitePublicOrigin,
      logger: request.log,
    })

    return reply.code(result.status === "success" ? 200 : 500).send(result)
  })

  // ---------------------------------------------------------------------------
  // GET /jira/status — monitoring endpoint
  // ---------------------------------------------------------------------------
  app.get("/jira/status", async (request, reply) => {
    if (!config) {
      return reply.code(503).send({ error: "JIRA integration not configured (JIRA_BASE_URL and JIRA_API_TOKEN required)" })
    }

    const providedSecret = (request.headers["x-jira-webhook-secret"] as string)
      ?? (request.query as Record<string, string>).secret
    if (!validateWebhookSecret(providedSecret, config.webhookSecret)) {
      return reply.code(401).send({ error: "Invalid webhook secret" })
    }

    const processing = getProcessingStatus()
    const poller = getPollerStatus()

    return {
      configured: config !== null,
      reviewStatus: config.reviewStatus,
      executeStatus: config.executeStatus,
      previewStatus: config.previewStatus,
      doneStatus: config.doneStatus,
      autoPublish: config.autoPublish,
      agentAccountId: config.agentAccountId ?? null,
      poller,
      ...processing,
    }
  })
}
