import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { routePollerIssue } from "./jira-poller.js"
import type { JiraConfig, JiraIssue, JiraComment } from "./jira-types.js"

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
    agentAccountId: "agent",
    siteId: "s",
    session: "jira",
    autoPublish: false,
    maxReviewPasses: 3,
    pollEnabled: false,
    pollJql: "",
    pollIntervalMs: 60_000,
    ...overrides,
  }
}

function comment(author: string, body: string, created: string): JiraComment {
  return {
    id: `c-${created}`,
    author: { accountId: author, displayName: author },
    body,
    created,
    updated: created,
  }
}

function issue(status: string, comments: JiraComment[]): JiraIssue {
  return {
    key: "TEST-1",
    id: "1",
    fields: {
      summary: "", description: "",
      status: { name: status, id: "x" },
      labels: [], attachment: [],
      comment: { comments },
    },
  }
}

describe("routePollerIssue", () => {
  test("To Do ticket with no agent comments → review", () => {
    const i = issue("To Do", [
      comment("reporter", "Please update the hero.", "2026-01-01T10:00:00Z"),
    ])
    const r = routePollerIssue(i, cfg())
    assert.ok(r, "expected a route")
    assert.equal(r!.mode, "review")
  })

  test("To Do with agent review already posted and no newer reporter comment → null (waiting)", () => {
    const i = issue("To Do", [
      comment("reporter", "Please update the hero.", "2026-01-01T10:00:00Z"),
      comment("agent", "<!-- site-editor:proceed -->\n**Ready to proceed.**", "2026-01-01T10:05:00Z"),
    ])
    assert.equal(routePollerIssue(i, cfg()), null)
  })

  test("To Do with reporter approval comment newer than agent → execute", () => {
    const i = issue("To Do", [
      comment("reporter", "Please update the hero.", "2026-01-01T10:00:00Z"),
      comment("agent", "<!-- site-editor:proceed -->\n**Ready to proceed.**", "2026-01-01T10:05:00Z"),
      comment("reporter", "go", "2026-01-01T10:10:00Z"),
    ])
    const r = routePollerIssue(i, cfg())
    assert.ok(r)
    assert.equal(r!.mode, "execute")
  })

  test("To Do with reporter non-approval follow-up after agent → review (re-review)", () => {
    const i = issue("To Do", [
      comment("agent", "<!-- site-editor:review -->", "2026-01-01T10:00:00Z"),
      comment("reporter", "Actually use the pricing page", "2026-01-01T10:05:00Z"),
    ])
    const r = routePollerIssue(i, cfg())
    assert.ok(r)
    assert.equal(r!.mode, "review")
  })

  test("In Review + reporter approval → publish", () => {
    const i = issue("In Review", [
      comment("agent", "<!-- site-editor:executed --> draft ready", "2026-01-01T11:00:00Z"),
      comment("reporter", "lgtm", "2026-01-01T11:05:00Z"),
    ])
    const r = routePollerIssue(i, cfg())
    assert.ok(r)
    assert.equal(r!.mode, "publish")
  })

  test("In Review + reporter follow-up instruction → execute (re-edit)", () => {
    const i = issue("In Review", [
      comment("agent", "<!-- site-editor:executed --> draft ready", "2026-01-01T11:00:00Z"),
      comment("reporter", "please also add a CTA at the bottom", "2026-01-01T11:05:00Z"),
    ])
    const r = routePollerIssue(i, cfg())
    assert.ok(r)
    assert.equal(r!.mode, "execute")
  })

  test("In Review + no reporter follow-up → null (waiting)", () => {
    const i = issue("In Review", [
      comment("agent", "<!-- site-editor:executed -->", "2026-01-01T11:00:00Z"),
    ])
    assert.equal(routePollerIssue(i, cfg()), null)
  })

  test("Done status → null", () => {
    const i = issue("Done", [])
    assert.equal(routePollerIssue(i, cfg()), null)
  })
})
