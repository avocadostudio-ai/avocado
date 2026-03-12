import test from "node:test"
import assert from "node:assert/strict"
import { validateAgainstSchema, validateToolManifestShape } from "./schema-validator.js"

test("validateToolManifestShape accepts a valid manifest", () => {
  const result = validateToolManifestShape({
    name: "unsplash.search",
    description: "Search",
    capability: "read",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 2 },
    idempotent: true,
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object" } } }, required: ["items"] }
  })
  assert.equal(result.ok, true)
})

test("validateToolManifestShape rejects invalid capability", () => {
  const result = validateToolManifestShape({
    name: "bad",
    description: "bad",
    capability: "execute",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1 },
    idempotent: true,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  })
  assert.equal(result.ok, false)
})

test("validateAgainstSchema validates object required fields", () => {
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string" as const },
      limit: { type: "integer" as const }
    }
  }

  const missing = validateAgainstSchema({}, schema)
  assert.equal(missing.ok, false)

  const invalid = validateAgainstSchema({ query: "mountain", extra: true }, schema)
  assert.equal(invalid.ok, false)

  const valid = validateAgainstSchema({ query: "mountain", limit: 2 }, schema)
  assert.equal(valid.ok, true)
})
