#!/usr/bin/env npx tsx
/**
 * Avocado Studio MCP server — streamable HTTP transport.
 *
 * Run this when you want the MCP server accessible as a URL (Claude Desktop's
 * "Add custom connector" flow, remote deployments). The stdio entry at
 * src/index.ts remains the right choice for local Claude Code installs.
 *
 * Env vars (in addition to the stdio ones):
 *   AVOCADO_MCP_BEARER_TOKEN  required — clients must send Authorization: Bearer <token>
 *   AVOCADO_MCP_PORT          optional — defaults to 4300
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { loadConfig } from "./config.ts"
import { OrchestratorClient } from "./orchestrator-client.ts"
import { registerAllTools } from "./tools/index.ts"
import { checkBearer } from "./http-auth.ts"

const config = loadConfig()

const bearerToken = process.env.AVOCADO_MCP_BEARER_TOKEN?.trim()
if (!bearerToken) {
  console.error("AVOCADO_MCP_BEARER_TOKEN is required for HTTP mode. Generate one with `openssl rand -hex 32`.")
  process.exit(1)
}

const port = Number(process.env.AVOCADO_MCP_PORT ?? "4300")
if (!Number.isFinite(port) || port <= 0) {
  console.error(`AVOCADO_MCP_PORT must be a positive integer, got: ${process.env.AVOCADO_MCP_PORT}`)
  process.exit(1)
}

const orchestratorClient = new OrchestratorClient(config)

/**
 * Build a fresh McpServer for each request. Per the SDK's stateless example,
 * the server+transport pair is disposed when the HTTP response closes. Registering
 * tools is cheap (pure wiring) — the heavy side effect (block schema registration)
 * ran once at module load.
 */
function buildServer(): McpServer {
  const server = new McpServer({ name: "avocado-studio", version: "0.1.0" })
  registerAllTools(server, orchestratorClient)
  return server
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

  // Health probe — no auth, useful for load balancers and Claude Desktop connectivity tests.
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, name: "avocado-studio", siteId: config.siteId })
  }

  if (url.pathname !== "/mcp") {
    return sendJson(res, 404, { error: "not found" })
  }

  const auth = checkBearer(req, bearerToken!)
  if (!auth.ok) {
    res.setHeader("www-authenticate", "Bearer")
    return sendJson(res, auth.status, { error: auth.message })
  }

  // Stateless mode only supports POST (initialize + JSON-RPC calls in one shot).
  // Reject GET/DELETE explicitly so clients fall back to the POST-only path.
  if (req.method !== "POST") {
    res.setHeader("allow", "POST")
    return sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Stateless MCP transport uses POST only." },
      id: null,
    })
  }

  const server = buildServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on("close", () => {
    transport.close().catch(() => { /* already closed */ })
    server.close().catch(() => { /* already closed */ })
  })

  try {
    const body = await readBody(req)
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      })
    } else {
      try { res.end() } catch { /* already closed */ }
    }
  }
})

httpServer.listen(port, () => {
  console.error(`avocado-studio MCP server listening on http://localhost:${port}/mcp (siteId: ${config.siteId})`)
})

const shutdown = () => {
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
