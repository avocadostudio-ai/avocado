import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { HttpError, request } from "./http.js"

type FetchArgs = [input: string | URL, init?: RequestInit]

let captured: FetchArgs[] = []
let mockResponse: Response | null = null
let mockError: Error | null = null
const realFetch = globalThis.fetch

function installFetchMock(response: Response | Error) {
  captured = []
  mockResponse = response instanceof Response ? response : null
  mockError = response instanceof Error ? response : null
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    captured.push([input, init])
    if (mockError) throw mockError
    return mockResponse!
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const cfg = { orchestrator: "http://orc:4200", session: "dev" }

test("request: drops undefined / null / empty-string query params", async () => {
  installFetchMock(new Response("{}", { status: 200 }))
  await request(cfg, "/publish/diff", { query: { a: "keep", b: undefined, c: "", d: 0 } })
  const url = new URL(String(captured[0][0]))
  assert.equal(url.searchParams.get("a"), "keep")
  assert.equal(url.searchParams.get("b"), null)
  assert.equal(url.searchParams.get("c"), null)
  assert.equal(url.searchParams.get("d"), "0")
})

test("request: only sets x-publish-token when requested AND token is present", async () => {
  installFetchMock(new Response("{}", { status: 200 }))
  // no token → no header even if flagged
  await request(cfg, "/publish", { method: "POST", body: {}, includePublishToken: true })
  const headers1 = new Headers((captured[0][1]?.headers as HeadersInit) ?? {})
  assert.equal(headers1.get("x-publish-token"), null)

  // token present but not flagged → still no header
  installFetchMock(new Response("{}", { status: 200 }))
  await request({ ...cfg, publishToken: "abc" }, "/anything")
  const headers2 = new Headers((captured[0][1]?.headers as HeadersInit) ?? {})
  assert.equal(headers2.get("x-publish-token"), null)

  // token present and flagged → header set
  installFetchMock(new Response("{}", { status: 200 }))
  await request({ ...cfg, publishToken: "abc" }, "/publish", {
    method: "POST", body: {}, includePublishToken: true,
  })
  const headers3 = new Headers((captured[0][1]?.headers as HeadersInit) ?? {})
  assert.equal(headers3.get("x-publish-token"), "abc")
})

test("request: non-2xx responses throw HttpError with status + body", async () => {
  installFetchMock(new Response("nope", { status: 401 }))
  await assert.rejects(
    () => request(cfg, "/publish", { method: "POST", body: {} }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError)
      assert.equal(err.status, 401)
      assert.equal(err.body, "nope")
      return true
    },
  )
})

test("request: network errors surface as a readable message, not HttpError", async () => {
  installFetchMock(new TypeError("fetch failed"))
  await assert.rejects(
    () => request(cfg, "/health"),
    (err: unknown) => {
      assert.ok(!(err instanceof HttpError))
      assert.match((err as Error).message, /Could not reach orchestrator at http:\/\/orc:4200/)
      return true
    },
  )
})

test("request: empty response body is returned as undefined", async () => {
  installFetchMock(new Response("", { status: 200 }))
  const out = await request(cfg, "/whatever")
  assert.equal(out, undefined)
})

test("request: non-JSON response body passes through as string", async () => {
  installFetchMock(new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } }))
  const out = await request<string>(cfg, "/whatever")
  assert.equal(out, "hello world")
})
