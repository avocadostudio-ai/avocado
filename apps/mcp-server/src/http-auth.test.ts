import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import { checkBearer } from "./http-auth.ts"

function mockReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe("checkBearer", () => {
  const expected = "s3cret-token"

  it("accepts a valid Bearer token", () => {
    const result = checkBearer(mockReq({ authorization: `Bearer ${expected}` }), expected)
    assert.equal(result.ok, true)
  })

  it("rejects when Authorization header is missing", () => {
    const result = checkBearer(mockReq({}), expected)
    assert.deepEqual(result, { ok: false, status: 401, message: "missing Authorization header" })
  })

  it("rejects non-Bearer auth schemes", () => {
    const result = checkBearer(mockReq({ authorization: `Basic ${expected}` }), expected)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 401)
  })

  it("rejects wrong token with 403", () => {
    const result = checkBearer(mockReq({ authorization: "Bearer wrong-token" }), expected)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 403)
  })

  it("rejects token of different length (length-mismatch short-circuit)", () => {
    const result = checkBearer(mockReq({ authorization: "Bearer x" }), expected)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.status, 403)
  })

  it("tolerates whitespace around the scheme", () => {
    const result = checkBearer(mockReq({ authorization: `  Bearer   ${expected}  ` }), expected)
    assert.equal(result.ok, true)
  })
})
