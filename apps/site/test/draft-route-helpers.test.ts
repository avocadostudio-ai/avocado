import assert from "node:assert/strict"
import test from "node:test"
import { getSafeRedirectPath, isValidDraftSecret } from "../app/api/draft/helpers.ts"

test("isValidDraftSecret returns missing_config when no secret is configured", () => {
  const result = isValidDraftSecret("anything", {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, "missing_config")
})

test("isValidDraftSecret validates exact configured secret", () => {
  const env = { DRAFT_MODE_SECRET: "top-secret" }

  const invalid = isValidDraftSecret("wrong", env)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.reason, "invalid_secret")

  const valid = isValidDraftSecret("top-secret", env)
  assert.equal(valid.ok, true)
  assert.equal(valid.reason, null)
})

test("getSafeRedirectPath allows internal paths and blocks external redirects", () => {
  assert.equal(getSafeRedirectPath("/pricing?x=1"), "/pricing?x=1")
  assert.equal(getSafeRedirectPath("https://evil.example"), "/")
  assert.equal(getSafeRedirectPath("//evil.example"), "/")
  assert.equal(getSafeRedirectPath("%2Fabout"), "/about")
})
