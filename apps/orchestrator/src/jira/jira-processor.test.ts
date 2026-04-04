import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { adfToPlainText, getProcessingStatus } from "./jira-processor.js"
import { loadJiraConfig } from "./jira-types.js"

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

    const config = loadJiraConfig()
    assert.ok(config)
    assert.equal(config.baseUrl, "https://test.atlassian.net")
    assert.equal(config.apiToken, "test-token")
    assert.equal(config.triggerStatus, "Ready for Website Update")
    assert.equal(config.doneStatus, "Done")
    assert.equal(config.siteId, "avocado-stories")
    assert.equal(config.session, "jira")
    assert.equal(config.autoPublish, true)
    assert.equal(config.pollEnabled, false)
    assert.equal(config.pollIntervalMs, 60_000)

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
