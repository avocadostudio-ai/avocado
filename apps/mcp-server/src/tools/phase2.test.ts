import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { OrchestratorClient } from "../orchestrator-client.ts"
import type { McpConfig } from "../config.ts"
import { registerAllTools } from "./index.ts"

type RecordedCall = { url: string; method: string; body?: unknown; hasFormData: boolean; authHeader?: string }

function stubFetcher(responseBody: unknown = { ok: true }, status = 200) {
  const calls: RecordedCall[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({
      url,
      method: init?.method ?? "GET",
      hasFormData: typeof init?.body === "object" && init?.body !== null && (init.body as object).constructor.name === "FormData",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authHeader: headers?.authorization,
    })
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { fetcher, calls }
}

function buildServer(overrides: Partial<McpConfig> = {}) {
  const { fetcher, calls } = stubFetcher()
  const config: McpConfig = {
    orchestratorUrl: "http://test.local:4200",
    session: "sess",
    siteId: "avocado-stories",
    ...overrides,
  }
  const client = new OrchestratorClient(config, fetcher)
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerAllTools(server, client)
  return { server, client, calls }
}

/** Invoke a registered tool by name, bypassing the transport. */
async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const internal = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> })._registeredTools
  const tool = internal[name]
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool.handler(args, {}) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>
}

describe("Phase 2 tools — HTTP call shape", () => {
  it("avocado-list-sites calls GET /sites with the session", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-list-sites", {})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "GET")
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/sites")
    assert.equal(url.searchParams.get("session"), "sess")
  })

  it("avocado-register-site POSTs to /sites/register with session+siteId", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-register-site", { name: "Avocado", previewUrl: "http://localhost:3000" })
    assert.equal(calls[0].method, "POST")
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/sites/register")
    assert.deepEqual(calls[0].body, {
      session: "sess",
      siteId: "avocado-stories",
      name: "Avocado",
      previewUrl: "http://localhost:3000",
    })
  })

  it("avocado-update-site-config emits a single update_site_config op", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-update-site-config", { name: "New Name", navLabels: { "/pricing": "Plans" } })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/ops")
    const body = calls[0].body as { ops: unknown[] }
    assert.equal(body.ops.length, 1)
    assert.deepEqual(body.ops[0], { op: "update_site_config", patch: { name: "New Name", navLabels: { "/pricing": "Plans" } } })
  })

  it("avocado-update-site-config refuses empty patch", async () => {
    const { server, calls } = buildServer()
    const res = await callTool(server, "avocado-update-site-config", {})
    assert.equal(res.isError, true)
    assert.equal(calls.length, 0)
  })

  it("avocado-generate-image POSTs to /image/generate with prompt body", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-generate-image", { prompt: "sunset", aspectRatio: "landscape" })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/image/generate")
    assert.deepEqual(calls[0].body, { prompt: "sunset", aspectRatio: "landscape" })
  })

  it("avocado-upload-image POSTs multipart to /image/upload", async () => {
    const { server, calls } = buildServer()
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    await callTool(server, "avocado-upload-image", { base64Data: tinyPng, mimeType: "image/png" })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/image/upload")
    assert.equal(calls[0].method, "POST")
    assert.equal(calls[0].hasFormData, true)
  })

  it("avocado-search-unsplash GETs /unsplash/search with query params", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-search-unsplash", { q: "mountains", limit: 5 })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/unsplash/search")
    assert.equal(url.searchParams.get("q"), "mountains")
    assert.equal(url.searchParams.get("limit"), "5")
  })

  it("avocado-publish-content refuses without AVOCADO_PUBLISH_TOKEN", async () => {
    const { server, calls } = buildServer()
    const res = await callTool(server, "avocado-publish-content", {})
    assert.equal(res.isError, true)
    assert.ok(res.content[0].text.includes("AVOCADO_PUBLISH_TOKEN"))
    assert.equal(calls.length, 0)
  })

  it("avocado-publish-content sends bearer token when configured", async () => {
    const { server, calls } = buildServer({ publishToken: "secret-token-123" })
    await callTool(server, "avocado-publish-content", {})
    assert.equal(calls[0].method, "POST")
    assert.equal(calls[0].authHeader, "Bearer secret-token-123")
  })

  it("avocado-list-snapshots GETs /restore/snapshots with siteId", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-list-snapshots", { limit: 10 })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/restore/snapshots")
    assert.equal(url.searchParams.get("siteId"), "avocado-stories")
    assert.equal(url.searchParams.get("limit"), "10")
  })

  it("avocado-restore-snapshot validates commit sha format", async () => {
    const { server, calls } = buildServer()
    const res = await callTool(server, "avocado-restore-snapshot", { commit: "not-a-sha" })
    assert.equal(res.isError, true)
    assert.equal(calls.length, 0)
  })

  it("avocado-undo-edit POSTs /history/undo with slug+session+siteId", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-undo-edit", { slug: "/" })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/history/undo")
    assert.deepEqual(calls[0].body, { session: "sess", siteId: "avocado-stories", slug: "/" })
  })

  it("avocado-chat-plan POSTs /chat with the full scoped body", async () => {
    const { server, calls } = buildServer()
    await callTool(server, "avocado-chat-plan", { message: "make the hero bolder", slug: "/" })
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/chat")
    assert.deepEqual(calls[0].body, {
      session: "sess",
      siteId: "avocado-stories",
      message: "make the hero bolder",
      slug: "/",
    })
  })
})
