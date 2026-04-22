import type { IncomingMessage } from "node:http"

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; message: string }

/**
 * Validate a bearer token on an incoming HTTP request. Returns a result object
 * instead of throwing so the caller can still reply with a clean JSON-RPC error.
 * Uses a constant-time compare to resist timing attacks.
 */
export function checkBearer(req: IncomingMessage, expected: string): AuthResult {
  const header = req.headers.authorization
  if (!header || typeof header !== "string") {
    return { ok: false, status: 401, message: "missing Authorization header" }
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) {
    return { ok: false, status: 401, message: "Authorization header must be 'Bearer <token>'" }
  }
  const presented = match[1]
  if (presented.length !== expected.length) {
    return { ok: false, status: 403, message: "invalid token" }
  }
  let mismatch = 0
  for (let i = 0; i < presented.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  if (mismatch !== 0) return { ok: false, status: 403, message: "invalid token" }
  return { ok: true }
}
