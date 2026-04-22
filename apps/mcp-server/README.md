# Avocado Studio MCP Server

Exposes Avocado Studio's page, block, and discovery tools over the [Model Context Protocol](https://modelcontextprotocol.io/) so MCP hosts (Claude Desktop, Claude Code, etc.) can drive a site the same way a human does in the editor.

Each install is scoped to **one site**: `(session, siteId)` are bound at launch via env vars. The server is a thin wrapper over the orchestrator HTTP API — the orchestrator remains the source of truth for validation, persistence, undo history, and demo-mode gating.

## Phase 1 scope

| Group | Tools |
|------|-------|
| Discovery | `avocado-list-block-types`, `avocado-get-block-schema` |
| Pages | `avocado-get-page`, `avocado-list-pages`, `avocado-create-page`, `avocado-rename-page`, `avocado-duplicate-page`, `avocado-remove-page`, `avocado-update-page-meta` |
| Blocks | `avocado-add-block`, `avocado-update-block-props`, `avocado-remove-block`, `avocado-move-block`, `avocado-duplicate-block`, `avocado-add-list-item`, `avocado-update-list-item`, `avocado-remove-list-item`, `avocado-move-list-item` |

Transport: **stdio** (the MCP host spawns the server as a subprocess).

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

## Env vars

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `AVOCADO_SITE_ID` | **yes** | — | Which site this install edits (e.g. `avocado-stories`). |
| `ORCHESTRATOR_URL` | no | `http://localhost:4200` | Points at the Avocado Studio orchestrator. |
| `AVOCADO_SESSION` | no | `dev` | Session key that scopes draft state. |

## Design notes

- **Thin wrapper, single source of truth.** Every mutation goes through `POST /ops`, which runs the existing Zod validation, ops-engine, undo stack, version log, and demo-mode gate. The MCP server never mutates state directly.
- **Discovery before mutation.** `avocado-list-block-types` + `avocado-get-block-schema` are the intended entry points for agents. Calling `avocado-add-block` without first fetching the schema risks invalid prop shapes → 400 from the orchestrator.
- **Read-only vs. destructive.** Discovery and `avocado-get-page` / `avocado-list-pages` are safe to mark **Always allow**. Mutations should stay on **Ask**.
- **Side-effect import.** `src/tools/discovery.ts` imports `@ai-site-editor/shared/src/blocks/index.ts` purely to trigger each block's `registerBlock()` call.

## Tests

```bash
pnpm --filter @ai-site-editor/mcp-server test
pnpm --filter @ai-site-editor/mcp-server typecheck
```

Tests stub `fetch` to assert HTTP call shape. They don't start a real orchestrator.

## Forward plan

### Phase 2 — more tool groups
- **Sites**: `avocado-register-site`, `avocado-list-sites`, `avocado-get-site-config`, `avocado-update-site-config`.
- **Media**: `avocado-upload-image`, `avocado-generate-image`, `avocado-search-unsplash`, `avocado-transcribe-audio`, `avocado-interpret-image`.
- **Publishing**: `avocado-compute-publish-diff`, `avocado-publish-content`, `avocado-get-publish-status`, `avocado-list-snapshots`, `avocado-restore-snapshot`.
- **History**: `avocado-undo-edit`, `avocado-redo-edit`, `avocado-restore-version`.
- **Chat planner shortcut**: `avocado-chat-plan` — accepts natural language, runs the full planner, returns applied ops. The "easy button" for hosts that don't want to wire 30 granular tools.

### Phase 3 — Claude connector (remote transport)
Goal: publish a hosted MCP server that Claude Desktop users install via **Settings → Connectors → Add custom connector** (the flow AEM uses for "AEM Content MCP Service").

Work:
1. **HTTP + SSE transport** — swap `StdioServerTransport` for `StreamableHTTPServerTransport`. Mount at `/mcp` inside the orchestrator Fastify app or run as a separate service on Render.
2. **OAuth gateway** — AEM uses "Complete the Adobe login flow" after the user enters the connector URL. Implement OAuth 2.1 with PKCE in front of `/mcp` so users authenticate to Avocado Studio once; token binds the session + siteId to each request. Reuse the existing `ACCESS_PASSWORD_HASH` flow as a dev fallback.
3. **Scoping per install** — `siteId` encoded into the OAuth token claims. One connector install → one site, matching our Phase 1 model.
4. **Claude connector registration** — submit to Anthropic's connector directory so it shows up as "Avocado Studio Content MCP Service" in Claude Desktop's built-in list (the AEM pattern). Requires: public HTTPS URL, OAuth endpoints, logo, description, per-tool permission matrix screenshot.
5. **Safety additions** the AEM docs hint at: per-tool "read-only" flag so Claude auto-allows read tools; audit log of tool calls per session (we can piggyback on the existing orchestrator telemetry); rate limit on `/mcp` (reuse demo-mode's per-IP limiter).

### Phase 4 — nice-to-haves
- MCP resources (not just tools) for page + site-config, so hosts can pin them as context without a tool call.
- MCP prompts (slash-command templates) for common flows: "draft a pricing page", "refresh hero copy site-wide".
- Typed client SDK generated from the orchestrator's OpenAPI so the wrapper stays auto-synced.
