# Avocado Studio MCP Server

Exposes Avocado Studio's page, block, and discovery tools over the [Model Context Protocol](https://modelcontextprotocol.io/) so MCP hosts (Claude Desktop, Claude Code, etc.) can drive a site the same way a human does in the editor.

Each install is scoped to **one site**: `(session, siteId)` are bound at launch via env vars. The server is a thin wrapper over the orchestrator HTTP API — the orchestrator remains the source of truth for validation, persistence, undo history, and demo-mode gating.

## Tool catalog (40 tools)

| Group | Tools |
|------|-------|
| Discovery | `avocado-list-block-types`, `avocado-get-block-schema` |
| Pages | `avocado-get-page`, `avocado-list-pages`, `avocado-create-page`, `avocado-rename-page`, `avocado-duplicate-page`, `avocado-remove-page`, `avocado-update-page-meta` |
| Blocks | `avocado-add-block`, `avocado-update-block-props`, `avocado-remove-block`, `avocado-move-block`, `avocado-duplicate-block`, `avocado-add-list-item`, `avocado-update-list-item`, `avocado-remove-list-item`, `avocado-move-list-item` |
| Sites | `avocado-register-site`, `avocado-list-sites`, `avocado-get-site-config`, `avocado-update-site-config` |
| Media | `avocado-upload-image`, `avocado-generate-image`, `avocado-search-unsplash`, `avocado-transcribe-audio`, `avocado-interpret-image` |
| Publishing | `avocado-compute-publish-diff`, `avocado-publish-content`, `avocado-get-publish-status`, `avocado-list-snapshots`, `avocado-restore-snapshot` |
| History | `avocado-undo-edit`, `avocado-redo-edit`, `avocado-restore-version` |
| Planner | `avocado-chat-plan`, `avocado-preview-plan`, `avocado-approve-pending-plan`, `avocado-discard-pending-plan` |
| Preview | `avocado-screenshot-page` — returns a full-page JPEG inline (visual feedback channel for chat-only hosts like Claude Desktop) |

Two transports, same tool registry:
- **stdio** — `src/index.ts`. MCP host spawns the server as a subprocess. Best for local dev / Claude Code.
- **HTTP (streamable)** — `src/http.ts`. Runs on a port; MCP hosts connect via URL + bearer token. Required for Claude Desktop's "Add custom connector" flow and remote deployments.

## Install — Claude Code

```bash
claude mcp add avocado \
  --env ORCHESTRATOR_URL=http://localhost:4200 \
  --env AVOCADO_SESSION=dev \
  --env AVOCADO_SITE_ID=avocado-stories \
  -- npx tsx /absolute/path/to/apps/mcp-server/src/index.ts
```

## Install — Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "avocado-studio": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/apps/mcp-server/src/index.ts"],
      "env": {
        "ORCHESTRATOR_URL": "http://localhost:4200",
        "AVOCADO_SESSION": "dev",
        "AVOCADO_SITE_ID": "avocado-stories"
      }
    }
  }
}
```

Restart Claude Desktop. Tools appear under `avocado-studio` and can be individually set to **Always allow / Ask / Never allow**.

## Install — HTTP / custom connector

Start the HTTP server:

```bash
AVOCADO_SITE_ID=avocado-stories \
AVOCADO_MCP_BEARER_TOKEN=$(openssl rand -hex 32) \
pnpm --filter @ai-site-editor/mcp-server start:http
# → avocado-studio MCP server listening on http://localhost:4300/mcp
```

Health probe (no auth): `curl http://localhost:4300/healthz`

In Claude Desktop → **Settings → Connectors → Add custom connector**:

- **URL:** `http://localhost:4300/mcp` (or a public HTTPS URL once deployed)
- **Auth:** Bearer — paste the token you generated above

Raw JSON-RPC example:

```bash
curl -X POST http://localhost:4300/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The HTTP transport runs in **stateless mode** — each request is independent, no session state on the server. POST only (GET/DELETE return 405).

## Env vars

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `AVOCADO_SITE_ID` | **yes** | — | Which site this install edits (e.g. `avocado-stories`). |
| `ORCHESTRATOR_URL` | no | `http://localhost:4200` | Points at the Avocado Studio orchestrator. |
| `AVOCADO_SESSION` | no | `dev` | Session key that scopes draft state. |
| `AVOCADO_PUBLISH_TOKEN` | no | — | Required only for `avocado-publish-content`. Must match the orchestrator's `DRAFT_MODE_SECRET`. Omit to disable publish through MCP. |
| `AVOCADO_MCP_BEARER_TOKEN` | **yes (HTTP mode)** | — | Shared secret clients must send as `Authorization: Bearer <token>`. Generate with `openssl rand -hex 32`. Only read by `src/http.ts`. |
| `AVOCADO_MCP_PORT` | no | `4300` | Port for HTTP mode. |

## Design notes

- **Thin wrapper, single source of truth.** Every mutation goes through `POST /ops`, which runs the existing Zod validation, ops-engine, undo stack, version log, and demo-mode gate. The MCP server never mutates state directly.
- **Discovery before mutation.** `avocado-list-block-types` + `avocado-get-block-schema` are the intended entry points for agents. Calling `avocado-add-block` without first fetching the schema risks invalid prop shapes → 400 from the orchestrator.
- **Read-only vs. destructive.** Discovery and `avocado-get-page` / `avocado-list-pages` are safe to mark **Always allow**. Mutations should stay on **Ask**.
- **Side-effect import.** `src/tools/discovery.ts` imports `@avocadostudio-ai/shared/src/blocks/index.ts` purely to trigger each block's `registerBlock()` call.

## Tests

```bash
pnpm --filter @ai-site-editor/mcp-server test
pnpm --filter @ai-site-editor/mcp-server typecheck
```

Tests stub `fetch` to assert HTTP call shape. They don't start a real orchestrator.

## Forward plan

### Phase 3a — HTTP transport ✅ shipped
`StreamableHTTPServerTransport` mounted in `src/http.ts` with bearer auth (`AVOCADO_MCP_BEARER_TOKEN`). Stateless mode, POST-only, `/healthz` probe. Testable locally; ready to deploy.

### Phase 3b — hosted deployment + OAuth
1. **Deploy** `apps/mcp-server` HTTP process to Render alongside the orchestrator. Public HTTPS URL required by Claude Desktop's connector flow.
2. **OAuth gateway** — AEM uses "Complete the Adobe login flow". Add OAuth 2.1 with PKCE in front of `/mcp` so bearer tokens are minted via an auth code exchange rather than shared-secret copy/paste. Token claims encode `siteId` (keeps per-site scoping).
3. **Claude connector directory submission** — public HTTPS URL, OAuth endpoints, logo, description, per-tool permission matrix screenshot. Lands "Avocado Studio Content MCP Service" in Claude Desktop's built-in connector list.
4. **Safety** — per-tool `readOnlyHint` annotations so Claude auto-allows reads; audit log piggybacking on existing orchestrator telemetry; rate limit on `/mcp` (reuse demo-mode's per-IP limiter).

### Phase 4 — nice-to-haves
- MCP resources (not just tools) for page + site-config, so hosts can pin them as context without a tool call.
- MCP prompts (slash-command templates) for common flows: "draft a pricing page", "refresh hero copy site-wide".
- Typed client SDK generated from the orchestrator's OpenAPI so the wrapper stays auto-synced.
