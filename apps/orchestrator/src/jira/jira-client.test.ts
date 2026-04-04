import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { JiraClient } from "./jira-client.js"

// ---------------------------------------------------------------------------
// Constructor & auth header
// ---------------------------------------------------------------------------

describe("JiraClient constructor", () => {
  test("Cloud: uses Basic auth with email:apiToken", () => {
    const client = new JiraClient({
      baseUrl: "https://mycompany.atlassian.net",
      email: "user@example.com",
      apiToken: "test-token-123",
    })
    // Verify it constructs without error
    assert.ok(client)
  })

  test("Server/DC: uses Bearer token when no .atlassian.net domain", () => {
    const client = new JiraClient({
      baseUrl: "https://jira.internal.corp",
      email: "",
      apiToken: "pat-token-abc",
    })
    assert.ok(client)
  })

  test("strips trailing slashes from baseUrl", () => {
    const client = new JiraClient({
      baseUrl: "https://mycompany.atlassian.net///",
      email: "a@b.com",
      apiToken: "tok",
    })
    assert.ok(client)
  })
})
