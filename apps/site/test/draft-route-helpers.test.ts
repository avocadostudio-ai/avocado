import assert from "node:assert/strict"
import test from "node:test"
import { validateDraftSecret, getSafeInternalRedirectPath } from "@ai-site-editor/shared"

test("validateDraftSecret returns missing_config when no secret is configured", () => {
  const result = validateDraftSecret("anything", {})
  assert.deepEqual(result, { ok: false, reason: "missing_config" })
})

test("validateDraftSecret validates exact configured secret", () => {
  const env = { DRAFT_MODE_SECRET: "top-secret" }

  const invalid = validateDraftSecret("wrong", env)
  assert.deepEqual(invalid, { ok: false, reason: "invalid_secret" })

  const valid = validateDraftSecret("top-secret", env)
  assert.deepEqual(valid, { ok: true, reason: null })
})

test("getSafeInternalRedirectPath allows internal paths and blocks external redirects", () => {
  assert.equal(getSafeInternalRedirectPath("/pricing?x=1"), "/pricing?x=1")
  assert.equal(getSafeInternalRedirectPath("https://evil.example"), "/")
  assert.equal(getSafeInternalRedirectPath("//evil.example"), "/")
  assert.equal(getSafeInternalRedirectPath("%2Fabout"), "/about")
})
