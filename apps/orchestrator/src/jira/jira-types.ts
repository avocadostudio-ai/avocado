/**
 * JIRA integration types.
 * Covers webhook payloads, REST API responses, and internal processing types.
 */

// ---------------------------------------------------------------------------
// JIRA REST API response shapes
// ---------------------------------------------------------------------------

export type JiraUser = {
  accountId?: string
  name?: string // Server/DC
  displayName: string
  emailAddress?: string
}

export type JiraIssue = {
  key: string
  id: string
  fields: {
    summary: string
    description: unknown // Atlassian Document Format (Cloud) or string (Server)
    status: { name: string; id: string }
    labels: string[]
    attachment: JiraAttachment[]
    reporter?: JiraUser
    assignee?: JiraUser | null
    creator?: JiraUser
    comment?: { comments: JiraComment[] }
    /** Custom fields can carry siteId, slug, etc. */
    [key: string]: unknown
  }
}

export type JiraComment = {
  id: string
  author: JiraUser
  body: unknown // ADF (Cloud) or string (Server)
  created: string
  updated: string
}

export type JiraAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  content: string // download URL
}

export type JiraTransition = {
  id: string
  name: string
  to: { name: string; id: string }
}

// ---------------------------------------------------------------------------
// JIRA Webhook payload (issue_updated event)
// ---------------------------------------------------------------------------

export type JiraWebhookPayload = {
  webhookEvent: string // e.g. "jira:issue_updated", "comment_created"
  issue_event_type_name?: string // e.g. "issue_generic", "issue_commented"
  timestamp: number
  issue: JiraIssue
  comment?: JiraComment // present for comment_created / comment_updated events
  changelog?: {
    items: Array<{
      field: string
      fieldtype: string
      from: string | null
      fromString: string | null
      to: string | null
      toString: string | null
    }>
  }
  user?: JiraUser
}

// ---------------------------------------------------------------------------
// Internal processing types
// ---------------------------------------------------------------------------

export type JiraProcessingResult = {
  issueKey: string
  status: "success" | "error"
  summary: string
  changes: string[]
  durationMs: number
  modelUsed?: string
  published?: boolean
  error?: string
}

export type JiraProcessingEntry = {
  issueKey: string
  state: "queued" | "processing" | "done" | "error"
  queuedAt: number
  startedAt?: number
  completedAt?: number
  result?: JiraProcessingResult
}

// ---------------------------------------------------------------------------
// Config (resolved from env vars)
// ---------------------------------------------------------------------------

export type JiraConfig = {
  baseUrl: string
  email: string
  apiToken: string
  webhookSecret?: string
  agentAccountId?: string  // JIRA account ID of the agent user (for @mention detection)
  triggerStatus: string
  doneStatus: string
  failedStatus?: string
  siteId: string
  session: string
  autoPublish: boolean
  pollEnabled: boolean
  pollJql: string
  pollIntervalMs: number
}

export function loadJiraConfig(): JiraConfig | null {
  const baseUrl = process.env.JIRA_BASE_URL?.trim()
  const apiToken = process.env.JIRA_API_TOKEN?.trim()
  if (!baseUrl || !apiToken) return null

  const triggerStatus = process.env.JIRA_TRIGGER_STATUS?.trim() || "Ready for Website Update"

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    email: process.env.JIRA_USER_EMAIL?.trim() ?? "",
    apiToken,
    webhookSecret: process.env.JIRA_WEBHOOK_SECRET?.trim() || undefined,
    agentAccountId: process.env.JIRA_AGENT_ACCOUNT_ID?.trim() || undefined,
    triggerStatus,
    doneStatus: process.env.JIRA_DONE_STATUS?.trim() || "Done",
    failedStatus: process.env.JIRA_FAILED_STATUS?.trim() || undefined,
    siteId: process.env.JIRA_SITE_ID?.trim() || "avocado-stories",
    session: process.env.JIRA_SESSION?.trim() || "jira",
    autoPublish: process.env.JIRA_AUTO_PUBLISH !== "0",
    pollEnabled: process.env.JIRA_POLL_ENABLED === "1",
    pollJql: process.env.JIRA_POLL_JQL?.trim() || `status = "${triggerStatus}" AND labels = "website-update"`,
    pollIntervalMs: Number(process.env.JIRA_POLL_INTERVAL_MS) || 60_000,
  }
}
