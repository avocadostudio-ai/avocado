import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { routeWebhook } from "./jira.js"
import type { JiraConfig, JiraWebhookPayload } from "../jira/jira-types.js"

function cfg(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return {
    baseUrl: "https://x.atlassian.net",
    email: "a@b.com",
    apiToken: "t",
    triggerStatus: "To Do",
    reviewStatus: "To Do",
    executeStatus: "In Progress",
    previewStatus: "In Review",
    doneStatus: "Done",
    agentAccountId: "agent-id",
    siteId: "s1",
    session: "jira",
    autoPublish: false,
    maxReviewPasses: 3,
    pollEnabled: false,
    pollJql: "",
    pollIntervalMs: 60_000,
    ...overrides,
  }
}

function baseIssue(status = "To Do") {
  return {
    key: "TEST-1",
    id: "1",
    fields: {
      summary: "x",
      description: "",
      status: { name: status, id: "1" },
      labels: [],
      attachment: [],
      reporter: { accountId: "reporter-id", displayName: "Reporter" },
    },
  }
}

describe("routeWebhook — comment events", () => {
  test("approval comment on To Do → execute", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
      comment: {
        id: "c1",
        author: { accountId: "reporter-id", displayName: "Reporter" },
        body: "ok, go ahead",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "execute")
  })

  test("non-approval comment on To Do → review (re-review)", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
      comment: {
        id: "c1",
        author: { accountId: "reporter-id", displayName: "Reporter" },
        body: "Actually, use the pricing page not the homepage.",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "review")
  })

  test("approval comment on In Review → publish", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("In Review") as never,
      comment: {
        id: "c1",
        author: { accountId: "reporter-id", displayName: "Reporter" },
        body: "lgtm",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "publish")
  })

  test("follow-up comment on In Review → execute (re-edit)", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("In Review") as never,
      comment: {
        id: "c1",
        author: { accountId: "reporter-id", displayName: "Reporter" },
        body: "Please also add a testimonials section",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "execute")
  })

  test("agent's own formatter-shaped comment is skipped (self-loop guard)", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
      comment: {
        id: "c1",
        author: { accountId: "agent-id", displayName: "Agent" },
        body: "**Review — I need a bit more info before I make changes.**\n\nQuestions: ...",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "skip")
  })

  test("solo tenant: plain reply from agent's accountId is treated as reporter input", () => {
    // Solo Jira tenants reuse one human accountId for both reporter and agent.
    // Without body-shape detection, replies would be silently dropped and the
    // workflow would stall.
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
      comment: {
        id: "c1",
        author: { accountId: "agent-id", displayName: "Solo user" },
        body: "use the home page, insert an Unsplash image",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") {
      assert.equal(route.mode, "review")
    }
  })

  test("comment on Done skipped unless it @mentions agent", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "comment_created",
      timestamp: 0,
      issue: baseIssue("Done") as never,
      comment: {
        id: "c1",
        author: { accountId: "reporter-id", displayName: "Reporter" },
        body: "Just checking in",
        created: "", updated: "",
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "skip")
  })
})

describe("routeWebhook — status-change events", () => {
  test("transition to To Do → review", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
      user: { accountId: "reporter-id", displayName: "Reporter" },
      changelog: {
        items: [{ field: "status", fieldtype: "jira", from: "1", fromString: "Backlog", to: "2", toString: "To Do" }],
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "review")
  })

  test("transition to In Progress → execute (manual start)", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      timestamp: 0,
      issue: baseIssue("In Progress") as never,
      user: { accountId: "reporter-id", displayName: "Reporter" },
      changelog: {
        items: [{ field: "status", fieldtype: "jira", from: "2", fromString: "To Do", to: "3", toString: "In Progress" }],
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "execute")
  })

  test("agent-authored status change skipped (self-loop guard)", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      timestamp: 0,
      issue: baseIssue("In Progress") as never,
      user: { accountId: "agent-id", displayName: "Agent" },
      changelog: {
        items: [{ field: "status", fieldtype: "jira", from: "2", fromString: "To Do", to: "3", toString: "In Progress" }],
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "skip")
  })

  test("transition to In Review does not trigger automatic action", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_updated",
      timestamp: 0,
      issue: baseIssue("In Review") as never,
      user: { accountId: "reporter-id", displayName: "Reporter" },
      changelog: {
        items: [{ field: "status", fieldtype: "jira", from: "3", fromString: "In Progress", to: "4", toString: "In Review" }],
      },
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "skip")
  })
})

describe("routeWebhook — issue_created events", () => {
  test("new issue assigned to agent → review", () => {
    const issue = baseIssue("To Do")
    ;(issue.fields as Record<string, unknown>).assignee = { accountId: "agent-id", displayName: "Agent" }
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_created",
      timestamp: 0,
      issue: issue as never,
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "review")
  })

  test("new issue created directly in To Do → review", () => {
    const payload: JiraWebhookPayload = {
      webhookEvent: "jira:issue_created",
      timestamp: 0,
      issue: baseIssue("To Do") as never,
    }
    const route = routeWebhook(payload, cfg())
    assert.equal(route.action, "process")
    if (route.action === "process") assert.equal(route.mode, "review")
  })
})
