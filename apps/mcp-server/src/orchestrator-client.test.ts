import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OrchestratorClient } from "./orchestrator-client.ts"
import type { McpConfig } from "./config.ts"

type RecordedCall = { url: string; method: string; body?: unknown }

function stubClient(responseBody: unknown = { ok: true }, status = 200) {
  const calls: RecordedCall[] = []
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    return new Response(JSON.stringify(responseBody), { status })
  }) as typeof fetch
  const config: McpConfig = {
    orchestratorUrl: "http://test.local:4200",
    session: "sess-1",
    siteId: "avocado-stories",
  }
  return { client: new OrchestratorClient(config, fetcher), calls }
}

describe("OrchestratorClient", () => {
  it("getPage sends session + siteId + slug as query params", async () => {
    const { client, calls } = stubClient({ id: "p_home", slug: "/", title: "Home", updatedAt: "t", blocks: [] })
    await client.getPage("/")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "GET")
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/draft/pages")
    assert.equal(url.searchParams.get("session"), "sess-1")
    assert.equal(url.searchParams.get("siteId"), "avocado-stories")
    assert.equal(url.searchParams.get("slug"), "/")
  })

  it("listSlugs hits /draft/slugs without slug param", async () => {
    const { client, calls } = stubClient({ slugs: ["/"] })
    await client.listSlugs()
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/draft/slugs")
    assert.equal(url.searchParams.get("slug"), null)
  })

  it("applyOps POSTs to /ops with session+siteId+ops in the body", async () => {
    const { client, calls } = stubClient({ status: "applied", summary: "", changes: [], mentionedSlugs: [], previewVersion: 1 })
    await client.applyOps([{ op: "remove_page", pageSlug: "/old" }])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "POST")
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, "/ops")
    assert.deepEqual(calls[0].body, {
      session: "sess-1",
      siteId: "avocado-stories",
      ops: [{ op: "remove_page", pageSlug: "/old" }],
    })
  })

  it("throws with status + body on non-2xx", async () => {
    const { client } = stubClient({ error: "page not found: /missing" }, 404)
    await assert.rejects(() => client.getPage("/missing"), /404/)
  })
})
