import { describe, test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  adfToPlainText,
  getProcessingStatus,
  cleanAgentSummary,
  resolveSiteForTicket,
  parseReviewDecision,
  countAgentReviewComments,
  buildCommentHistory,
} from "./jira-processor.js"
import { loadJiraConfig, type JiraConfig, type JiraIssue } from "./jira-types.js"
import { markdownToAdf } from "./jira-client.js"
import { siteConfigs } from "../state/session-state.js"

// ---------------------------------------------------------------------------
// ADF → plain text conversion
// ---------------------------------------------------------------------------

describe("adfToPlainText", () => {
  test("plain string passes through", () => {
    assert.equal(adfToPlainText("hello world"), "hello world")
  })

  test("null/undefined returns empty string", () => {
    assert.equal(adfToPlainText(null), "")
    assert.equal(adfToPlainText(undefined), "")
  })

  test("simple ADF document with paragraphs", () => {
    const adf = {
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "World" }],
        },
      ],
    }
    const result = adfToPlainText(adf)
    assert.ok(result.includes("Hello"))
    assert.ok(result.includes("World"))
  })

  test("heading node", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "heading",
          content: [{ type: "text", text: "Title" }],
        },
      ],
    }
    assert.ok(adfToPlainText(adf).includes("Title"))
  })

  test("bullet list", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Item one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Item two" }] },
              ],
            },
          ],
        },
      ],
    }
    const result = adfToPlainText(adf)
    assert.ok(result.includes("Item one"))
    assert.ok(result.includes("Item two"))
    assert.ok(result.includes("- "))
  })

  test("hardBreak becomes newline", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Line 1" },
            { type: "hardBreak" },
            { type: "text", text: "Line 2" },
          ],
        },
      ],
    }
    assert.ok(adfToPlainText(adf).includes("Line 1\nLine 2"))
  })

  test("code block", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "const x = 1" }],
        },
      ],
    }
    assert.ok(adfToPlainText(adf).includes("const x = 1"))
  })
})

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe("loadJiraConfig", () => {
  test("returns null when JIRA_BASE_URL is not set", () => {
    const origBase = process.env.JIRA_BASE_URL
    const origToken = process.env.JIRA_API_TOKEN
    delete process.env.JIRA_BASE_URL
    delete process.env.JIRA_API_TOKEN

    const config = loadJiraConfig()
    assert.equal(config, null)

    // Restore
    if (origBase) process.env.JIRA_BASE_URL = origBase
    if (origToken) process.env.JIRA_API_TOKEN = origToken
  })

  test("returns null when JIRA_API_TOKEN is not set", () => {
    const origBase = process.env.JIRA_BASE_URL
    const origToken = process.env.JIRA_API_TOKEN
    process.env.JIRA_BASE_URL = "https://test.atlassian.net"
    delete process.env.JIRA_API_TOKEN

    const config = loadJiraConfig()
    assert.equal(config, null)

    // Restore
    if (origBase) process.env.JIRA_BASE_URL = origBase
    else delete process.env.JIRA_BASE_URL
    if (origToken) process.env.JIRA_API_TOKEN = origToken
  })

  test("returns config with defaults when both URL and token are set", () => {
    const origBase = process.env.JIRA_BASE_URL
    const origToken = process.env.JIRA_API_TOKEN
    const origEmail = process.env.JIRA_USER_EMAIL
    process.env.JIRA_BASE_URL = "https://test.atlassian.net/"
    process.env.JIRA_API_TOKEN = "test-token"
    delete process.env.JIRA_USER_EMAIL

    const origReview = process.env.JIRA_REVIEW_STATUS
    const origTrigger = process.env.JIRA_TRIGGER_STATUS
    const origAutoPublish = process.env.JIRA_AUTO_PUBLISH
    delete process.env.JIRA_REVIEW_STATUS
    delete process.env.JIRA_TRIGGER_STATUS
    delete process.env.JIRA_AUTO_PUBLISH

    const config = loadJiraConfig()
    assert.ok(config)
    assert.equal(config.baseUrl, "https://test.atlassian.net")
    assert.equal(config.apiToken, "test-token")
    assert.equal(config.reviewStatus, "To Do")
    assert.equal(config.executeStatus, "In Progress")
    assert.equal(config.previewStatus, "In Review")
    assert.equal(config.doneStatus, "Done")
    assert.equal(config.siteId, "avocado-stories")
    assert.equal(config.session, "dev")
    assert.equal(config.autoPublish, false)
    assert.equal(config.maxReviewPasses, 3)
    assert.equal(config.pollEnabled, false)
    assert.equal(config.pollIntervalMs, 60_000)

    if (origReview !== undefined) process.env.JIRA_REVIEW_STATUS = origReview
    if (origTrigger !== undefined) process.env.JIRA_TRIGGER_STATUS = origTrigger
    if (origAutoPublish !== undefined) process.env.JIRA_AUTO_PUBLISH = origAutoPublish

    // Restore
    if (origBase) process.env.JIRA_BASE_URL = origBase
    else delete process.env.JIRA_BASE_URL
    if (origToken) process.env.JIRA_API_TOKEN = origToken
    else delete process.env.JIRA_API_TOKEN
    if (origEmail) process.env.JIRA_USER_EMAIL = origEmail
  })
})

// ---------------------------------------------------------------------------
// Processing status
// ---------------------------------------------------------------------------

describe("getProcessingStatus", () => {
  test("returns queue and recent arrays", () => {
    const status = getProcessingStatus()
    assert.ok(Array.isArray(status.queue))
    assert.ok(Array.isArray(status.recent))
  })
})

// ---------------------------------------------------------------------------
// cleanAgentSummary
// ---------------------------------------------------------------------------

describe("cleanAgentSummary", () => {
  test("strips <thinking> blocks", () => {
    const raw = "<thinking>internal plan</thinking>Here is the result."
    assert.equal(cleanAgentSummary(raw), "Here is the result.")
  })

  test("strips standalone <thinking> open/close tags on separate lines", () => {
    const raw = "<thinking>\nStep 1\nStep 2\n</thinking>\n\nFinal answer."
    const cleaned = cleanAgentSummary(raw)
    assert.ok(!cleaned.includes("<thinking>"), `still contains tag: ${cleaned}`)
    assert.ok(!cleaned.includes("</thinking>"), `still contains close tag: ${cleaned}`)
    assert.ok(cleaned.includes("Final answer."))
  })

  test("collapses excessive blank lines", () => {
    const raw = "Line one\n\n\n\n\nLine two"
    assert.equal(cleanAgentSummary(raw), "Line one\n\nLine two")
  })

  test("returns empty string for empty input", () => {
    assert.equal(cleanAgentSummary(""), "")
  })
})

// ---------------------------------------------------------------------------
// resolveSiteForTicket — multi-site disambiguation
// ---------------------------------------------------------------------------

function makeIssue(summary: string, description = ""): JiraIssue {
  return {
    key: "TEST-1",
    id: "1",
    fields: {
      summary,
      description,
      status: { name: "Open", id: "1" },
      labels: [],
      attachment: [],
    },
  }
}

function makeConfig(overrides: Partial<JiraConfig> = {}): JiraConfig {
  return {
    baseUrl: "https://example.atlassian.net",
    email: "test@example.com",
    apiToken: "token",
    triggerStatus: "To Do",
    reviewStatus: "To Do",
    executeStatus: "In Progress",
    previewStatus: "In Review",
    doneStatus: "Done",
    siteId: "avocado-stories",
    session: "jira",
    autoPublish: false,
    maxReviewPasses: 3,
    pollEnabled: false,
    pollJql: "",
    pollIntervalMs: 60_000,
    ...overrides,
  }
}

describe("resolveSiteForTicket", () => {
  const origEnv = process.env.JIRA_SITE_ID
  let snapshot: Array<[string, unknown]>

  beforeEach(() => {
    snapshot = Array.from(siteConfigs.entries())
  })
  afterEach(() => {
    siteConfigs.clear()
    for (const [k, v] of snapshot) siteConfigs.set(k, v as never)
    if (origEnv === undefined) delete process.env.JIRA_SITE_ID
    else process.env.JIRA_SITE_ID = origEnv
  })

  test("uses the single registered site (via single-site)", () => {
    siteConfigs.clear()
    siteConfigs.set("avocado-stories::dev", { name: "Avocado Stories" })
    delete process.env.JIRA_SITE_ID

    const result = resolveSiteForTicket(makeIssue("Update homepage"), makeConfig())
    assert.deepEqual(result, { siteId: "avocado-stories", via: "single-site" })
  })

  test("ambiguous when multiple sites exist and ticket names none", () => {
    siteConfigs.clear()
    siteConfigs.set("avocado-stories::dev", { name: "Avocado Stories" })
    siteConfigs.set("paintball-bern::dev", { name: "Paintball Bern" })
    delete process.env.JIRA_SITE_ID

    const result = resolveSiteForTicket(makeIssue("Update homepage"), makeConfig())
    assert.ok("ambiguous" in result && result.ambiguous === true)
    if ("ambiguous" in result) {
      const ids = result.candidates.map((c) => c.id).sort()
      assert.deepEqual(ids, ["avocado-stories", "paintball-bern"])
    }
  })

  test("resolves by site id mentioned in summary (via text-match)", () => {
    siteConfigs.clear()
    siteConfigs.set("avocado-stories::dev", { name: "Avocado Stories" })
    siteConfigs.set("paintball-bern::dev", { name: "Paintball Bern" })
    delete process.env.JIRA_SITE_ID

    const result = resolveSiteForTicket(
      makeIssue("Update paintball-bern homepage"),
      makeConfig()
    )
    assert.deepEqual(result, { siteId: "paintball-bern", via: "text-match" })
  })

  test("resolves by site display name mentioned in description (via text-match)", () => {
    siteConfigs.clear()
    siteConfigs.set("avocado-stories::dev", { name: "Avocado Stories" })
    siteConfigs.set("paintball-bern::dev", { name: "Paintball Bern" })
    delete process.env.JIRA_SITE_ID

    const result = resolveSiteForTicket(
      makeIssue("Homepage", "Please update the Paintball Bern homepage."),
      makeConfig()
    )
    assert.deepEqual(result, { siteId: "paintball-bern", via: "text-match" })
  })

  test("JIRA_SITE_ID does NOT lock: still ambiguous when multiple sites and no text match", () => {
    siteConfigs.clear()
    siteConfigs.set("avocado-stories::dev", { name: "Avocado Stories" })
    siteConfigs.set("paintball-bern::dev", { name: "Paintball Bern" })
    process.env.JIRA_SITE_ID = "avocado-stories"

    const result = resolveSiteForTicket(
      makeIssue("Update homepage"),
      makeConfig({ siteId: "avocado-stories" })
    )
    assert.ok("ambiguous" in result && result.ambiguous === true)
  })

  test("falls back to config.siteId when nothing is registered (via env-fallback)", () => {
    siteConfigs.clear()
    process.env.JIRA_SITE_ID = "avocado-stories"

    const result = resolveSiteForTicket(
      makeIssue("Update homepage"),
      makeConfig({ siteId: "avocado-stories" })
    )
    assert.deepEqual(result, { siteId: "avocado-stories", via: "env-fallback" })
  })

  test("falls back to config.siteId with default when nothing is registered and no env (via default-fallback)", () => {
    siteConfigs.clear()
    delete process.env.JIRA_SITE_ID

    const result = resolveSiteForTicket(
      makeIssue("Update homepage"),
      makeConfig({ siteId: "avocado-stories" })
    )
    assert.deepEqual(result, { siteId: "avocado-stories", via: "default-fallback" })
  })
})

// ---------------------------------------------------------------------------
// markdownToAdf — link + bulletList support
// ---------------------------------------------------------------------------

describe("markdownToAdf", () => {
  test("renders [label](url) as ADF link", () => {
    const doc = markdownToAdf("See [welcome](https://example.com/welcome) page.") as {
      content: Array<{ type: string; content: Array<Record<string, unknown>> }>
    }
    const paragraph = doc.content[0]
    assert.equal(paragraph.type, "paragraph")
    const link = paragraph.content.find((n) => Array.isArray(n.marks))
    assert.ok(link, "expected a text node with marks")
    assert.equal((link as { text: string }).text, "welcome")
    const marks = (link as { marks: Array<{ type: string; attrs?: { href: string } }> }).marks
    assert.equal(marks[0].type, "link")
    assert.equal(marks[0].attrs?.href, "https://example.com/welcome")
  })

  test("renders dash-prefixed lines as bulletList", () => {
    const doc = markdownToAdf("- one\n- two") as { content: Array<{ type: string }> }
    assert.equal(doc.content[0].type, "bulletList")
  })

  test("preserves bold plus link in the same line", () => {
    const doc = markdownToAdf("**Preview:** [/welcome](https://example.com/welcome)") as {
      content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string }> }> }>
    }
    const inline = doc.content[0].content
    const bold = inline.find((n) => n.marks?.[0]?.type === "strong")
    const link = inline.find((n) => n.marks?.[0]?.type === "link")
    assert.ok(bold && bold.text === "Preview:")
    assert.ok(link && link.text === "/welcome")
  })

  test("renders _text_ as italic (em)", () => {
    const doc = markdownToAdf("_What I think you want:_ update hero copy.") as {
      content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string }> }> }>
    }
    const inline = doc.content[0].content
    const em = inline.find((n) => n.marks?.[0]?.type === "em")
    assert.ok(em, "expected an em-marked text node")
    assert.equal(em!.text, "What I think you want:")
  })

  test("does not italicize underscores inside identifiers (snake_case)", () => {
    const doc = markdownToAdf("Update b_hero_home heading.") as {
      content: Array<{ content: Array<{ text: string; marks?: Array<{ type: string }> }> }>
    }
    const inline = doc.content[0].content
    const em = inline.find((n) => n.marks?.[0]?.type === "em")
    assert.equal(em, undefined, "snake_case should not trigger italics")
    const joined = inline.map((n) => n.text).join("")
    assert.ok(joined.includes("b_hero_home"), "identifier preserved verbatim")
  })

  test("strips HTML comments (<!-- ... -->)", () => {
    const doc = markdownToAdf("<!-- site-editor:review -->\n**Hello**") as {
      content: Array<{ type: string; content?: Array<{ text?: string }> }>
    }
    // The HTML comment line should be gone — only the bold paragraph remains.
    const joined = JSON.stringify(doc)
    assert.ok(!joined.includes("site-editor:review"), `HTML comment leaked: ${joined}`)
    assert.ok(joined.includes("Hello"))
  })

  test("renders pipe-delimited markdown table as ADF table node", () => {
    const md = [
      "| What | Before | After |",
      "|---|---|---|",
      "| Hero headline | \"Old\" | **New** |",
      "| Hero subtitle | x | y |",
    ].join("\n")
    const doc = markdownToAdf(md) as {
      content: Array<{ type: string; content?: Array<{ type: string; content?: unknown[] }> }>
    }
    const tables = doc.content.filter((n) => n.type === "table")
    assert.equal(tables.length, 1, "expected one table node")
    const table = tables[0]
    assert.equal(table.content?.length, 3, "header + 2 data rows")
    // First row: header cells
    const headerRow = table.content?.[0] as { content: Array<{ type: string }> }
    assert.ok(headerRow.content.every((c) => c.type === "tableHeader"))
    assert.equal(headerRow.content.length, 3)
    // Second row: data cells
    const firstData = table.content?.[1] as { content: Array<{ type: string }> }
    assert.ok(firstData.content.every((c) => c.type === "tableCell"))
  })

  test("tolerates blank lines between table rows (LLM-friendly)", () => {
    const md = [
      "| A | B |",
      "",
      "|---|---|",
      "",
      "| 1 | 2 |",
      "",
      "| 3 | 4 |",
    ].join("\n")
    const doc = markdownToAdf(md) as { content: Array<{ type: string; content?: unknown[] }> }
    const table = doc.content.find((n) => n.type === "table")
    assert.ok(table, "table node expected")
    assert.equal((table!.content as unknown[]).length, 3, "header + 2 data rows")
  })

  test("does not treat a single pipe-row as a table (no separator)", () => {
    const md = "| just | text |"
    const doc = markdownToAdf(md) as { content: Array<{ type: string }> }
    assert.equal(doc.content[0].type, "paragraph", "no separator → paragraph")
  })

  test("parses inline markdown inside table cells", () => {
    const md = [
      "| A | B |",
      "|---|---|",
      "| **bold** | [link](https://x) |",
    ].join("\n")
    const doc = markdownToAdf(md) as {
      content: Array<{ type: string; content?: Array<{ content: Array<{ content: Array<{ content: Array<{ marks?: Array<{ type: string }> }> }> }> }> }>
    }
    const table = doc.content.find((n) => n.type === "table")!
    const dataRow = (table.content as Array<{ content: Array<{ content: Array<{ content: Array<{ marks?: Array<{ type: string }> }> }> }> }>)[1]
    const boldCell = dataRow.content[0].content[0].content
    const linkCell = dataRow.content[1].content[0].content
    assert.ok(boldCell.some((n) => n.marks?.[0]?.type === "strong"), "bold preserved in cell")
    assert.ok(linkCell.some((n) => n.marks?.[0]?.type === "link"), "link preserved in cell")
  })
})

// ---------------------------------------------------------------------------
// Review-mode JSON parser
// ---------------------------------------------------------------------------

describe("parseReviewDecision", () => {
  test("parses a bare JSON proceed response", () => {
    const raw = '{"decision":"proceed","plan":["Update hero copy on /"]}'
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "proceed")
    assert.deepEqual(result.plan, ["Update hero copy on /"])
  })

  test("parses a questions response with array", () => {
    const raw = '{"decision":"questions","plan":["Best guess plan"],"questions":["Which page?","What copy?"]}'
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "questions")
    assert.deepEqual(result.questions, ["Which page?", "What copy?"])
  })

  test("extracts JSON from ```json fence", () => {
    const raw = 'Here is my plan:\n```json\n{"decision":"proceed","plan":["Do it"]}\n```'
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "proceed")
    assert.deepEqual(result.plan, ["Do it"])
  })

  test("extracts JSON when wrapped in prose", () => {
    const raw = 'Sure! {"decision":"proceed","plan":["Update hero"]} Hope that helps.'
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "proceed")
    assert.deepEqual(result.plan, ["Update hero"])
  })

  test("strips thinking tags before parsing", () => {
    const raw = '<thinking>Let me think</thinking>{"decision":"proceed","plan":["Go"]}'
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "proceed")
  })

  test("falls back to proceed when JSON is unparseable", () => {
    const raw = "Not JSON at all — just regular prose."
    const result = parseReviewDecision(raw)
    assert.equal(result.decision, "proceed")
    assert.ok(result.plan.length > 0, "fallback plan should not be empty")
  })

  test("filters out non-string questions", () => {
    const raw = '{"decision":"questions","plan":["X"],"questions":["ok",42,null,"fine"]}'
    const result = parseReviewDecision(raw)
    assert.deepEqual(result.questions, ["ok", "fine"])
  })

  test("back-compat: string plan is split into bullets on sentence boundaries", () => {
    const raw = '{"decision":"proceed","plan":"Update heading to X. Update subtitle to Y. Replace hero image."}'
    const result = parseReviewDecision(raw)
    assert.deepEqual(result.plan, [
      "Update heading to X.",
      "Update subtitle to Y.",
      "Replace hero image.",
    ])
  })

  test("back-compat: string plan with newlines is split on newlines", () => {
    const raw = '{"decision":"proceed","plan":"- Update heading\\n- Update subtitle"}'
    const result = parseReviewDecision(raw)
    assert.deepEqual(result.plan, ["Update heading", "Update subtitle"])
  })

  test("plan array is trimmed and empty items dropped", () => {
    const raw = '{"decision":"proceed","plan":["  step one  ","","step two"]}'
    const result = parseReviewDecision(raw)
    assert.deepEqual(result.plan, ["step one", "step two"])
  })
})

// ---------------------------------------------------------------------------
// Comment history — so reporter clarifications reach the execute agent
// ---------------------------------------------------------------------------

describe("buildCommentHistory", () => {
  function issueWith(comments: Array<{ author: string; body: string; created?: string }>): JiraIssue {
    return {
      key: "T-1",
      id: "1",
      fields: {
        summary: "", description: "",
        status: { name: "To Do", id: "1" },
        labels: [], attachment: [],
        comment: {
          comments: comments.map((c, i) => ({
            id: String(i),
            author: { accountId: c.author, displayName: c.author },
            body: c.body,
            created: c.created ?? "2026-04-19T10:00:00Z",
            updated: c.created ?? "2026-04-19T10:00:00Z",
          })),
        },
      },
    }
  }

  test("empty when no comments", () => {
    const issue = issueWith([])
    assert.equal(buildCommentHistory(issue, "agent"), "")
  })

  test("labels reporter and agent roles based on body shape", () => {
    const issue = issueWith([
      { author: "reporter", body: "Please update the hero", created: "2026-04-19T10:00:00Z" },
      { author: "agent", body: "**Review — I need a bit more info before I make changes.**\n\nQuestions: which page?", created: "2026-04-19T10:05:00Z" },
      { author: "reporter", body: "Use the home page, and this specific Unsplash URL: https://unsplash.com/photos/abc", created: "2026-04-19T10:10:00Z" },
    ])
    const out = buildCommentHistory(issue, "agent")
    assert.ok(out.includes("Reporter:\nPlease update the hero"))
    assert.ok(out.includes("Agent:\n**Review — I need a bit more info"))
    assert.ok(out.includes("Use the home page, and this specific Unsplash URL"))
    assert.ok(out.indexOf("Please update the hero") < out.indexOf("Unsplash URL"), "chronological order preserved")
  })

  test("solo tenant: agent-shaped body is labelled Agent even when accountId is shared", () => {
    const issue = issueWith([
      { author: "solo", body: "**Review — I need a bit more info before I make changes.**" },
      { author: "solo", body: "use the pricing page" },
    ])
    const out = buildCommentHistory(issue, "solo")
    assert.ok(out.includes("Agent:\n**Review"))
    assert.ok(out.includes("Reporter:\nuse the pricing page"), "plain reply from shared accountId must still be Reporter-labelled")
  })

  test("truncates very long bodies to keep token usage bounded", () => {
    const long = "x".repeat(2000)
    const issue = issueWith([{ author: "reporter", body: long }])
    const out = buildCommentHistory(issue, "agent")
    assert.ok(out.includes("[truncated]"))
    assert.ok(out.length < long.length + 200)
  })
})

// ---------------------------------------------------------------------------
// Review-pass counter — caps re-review loops
// ---------------------------------------------------------------------------

describe("countAgentReviewComments", () => {
  function makeIssueWithComments(comments: Array<{ author: string; body: string }>): JiraIssue {
    return {
      key: "TEST-1",
      id: "1",
      fields: {
        summary: "x",
        description: "",
        status: { name: "To Do", id: "1" },
        labels: [],
        attachment: [],
        comment: {
          comments: comments.map((c, i) => ({
            id: String(i),
            author: { accountId: c.author, displayName: c.author },
            body: c.body,
            created: "",
            updated: "",
          })),
        },
      },
    }
  }

  test("counts agent comments with review headlines", () => {
    const issue = makeIssueWithComments([
      { author: "agent", body: "**Review — I need a bit more info before I make changes.**" },
      { author: "reporter", body: "Here are the details." },
      { author: "agent", body: "**Review complete — ready to proceed.**" },
    ])
    assert.equal(countAgentReviewComments(issue, "agent"), 2)
  })

  test("counts the cap-reached headline as a review comment", () => {
    const issue = makeIssueWithComments([
      { author: "agent", body: "**I've asked for clarification several times.**\n\nReview attempts exhausted." },
    ])
    assert.equal(countAgentReviewComments(issue, "agent"), 1)
  })

  test("backward-compatible with legacy HTML-comment markers", () => {
    const issue = makeIssueWithComments([
      { author: "agent", body: "<!-- site-editor:review -->\nStale comment from before the format change." },
      { author: "agent", body: "<!-- site-editor:proceed -->\nAnother stale one." },
    ])
    assert.equal(countAgentReviewComments(issue, "agent"), 2)
  })

  test("ignores non-agent comments even if they mimic the headline", () => {
    const issue = makeIssueWithComments([
      { author: "reporter", body: "**Review — I'm pretending to be the agent.**" },
    ])
    assert.equal(countAgentReviewComments(issue, "agent"), 0)
  })

  test("ignores agent comments from non-review stages", () => {
    const issue = makeIssueWithComments([
      { author: "agent", body: "**Draft updated. Ready for your review.**" },
      { author: "agent", body: "**Published. Changes are live.**" },
    ])
    assert.equal(countAgentReviewComments(issue, "agent"), 0)
  })

  test("returns 0 when no comments exist", () => {
    const issue: JiraIssue = {
      key: "T", id: "1",
      fields: { summary: "", description: "", status: { name: "", id: "" }, labels: [], attachment: [] },
    }
    assert.equal(countAgentReviewComments(issue, "agent"), 0)
  })
})
