import test from "node:test"
import assert from "node:assert/strict"
import { ToolRegistry } from "./registry.js"
import { ToolExecutor } from "./executor.js"

test("ToolExecutor enforces read/write policy", async () => {
  const registry = new ToolRegistry()
  registry.registerBuiltin(
    {
      name: "content.write",
      description: "Write content",
      capability: "write",
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1 },
      idempotent: true,
      inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } },
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
    },
    async () => ({ ok: true })
  )

  const executor = new ToolExecutor(registry, { info: () => {}, warn: () => {} })
  const result = await executor.execute({
    toolName: "content.write",
    input: { value: "hello" },
    context: { siteId: "s1", sessionId: "sess", traceId: "trace", plannerProvider: "anthropic" }
  })

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, "tool_requires_approval")
})

test("ToolExecutor validates tool input/output", async () => {
  const registry = new ToolRegistry()
  registry.registerBuiltin(
    {
      name: "demo.read",
      description: "Read",
      capability: "read",
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1 },
      idempotent: true,
      inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false },
      outputSchema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } }, additionalProperties: false }
    },
    async () => ({ items: ["a", "b"] })
  )

  const executor = new ToolExecutor(registry, { info: () => {}, warn: () => {} })
  const invalid = await executor.execute({
    toolName: "demo.read",
    input: { foo: "bar" },
    context: { siteId: "s1", sessionId: "sess", traceId: "trace", plannerProvider: "anthropic" }
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error?.code, "invalid_tool_input")

  const valid = await executor.execute({
    toolName: "demo.read",
    input: { query: "mountains" },
    context: { siteId: "s1", sessionId: "sess", traceId: "trace", plannerProvider: "anthropic" }
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.data, { items: ["a", "b"] })
})
