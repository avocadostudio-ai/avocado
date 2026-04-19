import { describe, test } from "node:test"
import assert from "node:assert/strict"
import { isApprovalComment, APPROVAL_KEYWORDS } from "./jira-approval.js"

describe("isApprovalComment", () => {
  test("matches single-word approvals", () => {
    for (const word of ["proceed", "go", "yes", "ok", "approved", "lgtm", "confirm", "publish"]) {
      assert.equal(isApprovalComment(word), true, `expected approval for "${word}"`)
    }
  })

  test("matches approvals embedded in short sentences", () => {
    assert.equal(isApprovalComment("ok, please go ahead"), true)
    assert.equal(isApprovalComment("LGTM!"), true)
    assert.equal(isApprovalComment("Yes, looks good to me"), true)
    assert.equal(isApprovalComment("Please proceed with the changes."), true)
  })

  test("is case-insensitive", () => {
    assert.equal(isApprovalComment("APPROVED"), true)
    assert.equal(isApprovalComment("Ship It"), true)
  })

  test("rejects non-approval prose", () => {
    assert.equal(isApprovalComment("Can you also update the pricing page?"), false)
    assert.equal(isApprovalComment("Please change the hero image to something darker"), false)
    assert.equal(isApprovalComment("Let me think about it"), false)
  })

  test("rejects empty and non-string inputs", () => {
    assert.equal(isApprovalComment(""), false)
    assert.equal(isApprovalComment("   "), false)
    assert.equal(isApprovalComment(null), false)
    assert.equal(isApprovalComment(undefined), false)
    assert.equal(isApprovalComment(42), false)
  })

  test("word boundaries: does not match partial words", () => {
    // "confirmation" contains "confirm" but should not match as a whole word
    assert.equal(isApprovalComment("confirmation"), false)
    // "goodbye" starts with "go" — must not approve
    assert.equal(isApprovalComment("goodbye"), false)
    // "approval" vs "approve" — only the keyword forms match
    assert.equal(isApprovalComment("approval process"), false)
  })

  test("matches multi-word phrases like 'go ahead' and 'looks good'", () => {
    assert.equal(isApprovalComment("go ahead"), true)
    assert.equal(isApprovalComment("This looks good"), true)
    assert.equal(isApprovalComment("ship it!"), true)
  })

  test("exposes the keyword list for reference", () => {
    assert.ok(APPROVAL_KEYWORDS.includes("proceed"))
    assert.ok(APPROVAL_KEYWORDS.includes("publish"))
  })
})
