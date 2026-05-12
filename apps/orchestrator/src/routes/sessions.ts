/**
 * Session introspection HTTP API.
 *
 * Endpoints exposed so clients (editor, MCP server, admin tooling) can discover
 * which sessions this orchestrator has state for without shelling into SQLite.
 *
 *   GET /whoami   — the caller's bound session + a summary of its state
 *   GET /sessions — every session the orchestrator has state for
 *
 * Both are read-only. DEMO_MODE blanket-blocks both prefixes upstream (see
 * `BLOCKED_PREFIXES` in index.ts) to keep per-IP ephemeral sessions from
 * leaking into a cross-visitor directory.
 */

import type { FastifyInstance } from "fastify"
import {
  DEFAULT_SESSION,
  getSessionSummary,
  listSessionSummaries,
  publishedPageCountGlobal,
  scopedSessionKey,
} from "../state/session-state.js"
import type { RouteContext } from "./route-context.js"

export async function sessionsRoutes(app: FastifyInstance, _ctx: RouteContext) {
  app.get("/whoami", async (request) => {
    const query = request.query as { session?: string; siteId?: string }
    const sessionKey = scopedSessionKey(query.session ?? DEFAULT_SESSION, query.siteId)
    return {
      ...getSessionSummary(sessionKey),
      publishedPageCount: publishedPageCountGlobal(),
      orchestratorUrl: `${request.protocol}://${request.hostname}`,
    }
  })

  app.get("/sessions", async () => ({
    sessions: listSessionSummaries(),
    publishedPageCount: publishedPageCountGlobal(),
  }))
}
