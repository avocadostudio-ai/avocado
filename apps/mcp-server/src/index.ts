#!/usr/bin/env npx tsx
/**
 * Avocado Studio MCP server — stdio transport.
 *
 * Spawned by an MCP host (Claude Desktop, Claude Code, etc.) with env vars:
 *   ORCHESTRATOR_URL   — e.g. http://localhost:4200 or https://orchestrator.example.com
 *   AVOCADO_SESSION    — session key to scope drafts (defaults to "dev")
 *   AVOCADO_SITE_ID    — required; which site this install edits
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.ts"
import { OrchestratorClient } from "./orchestrator-client.ts"
import { registerAllTools } from "./tools/index.ts"

const config = loadConfig()
const client = new OrchestratorClient(config)
const server = new McpServer({ name: "avocado-studio", version: "0.1.0" })

registerAllTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)
