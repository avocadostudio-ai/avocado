# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Documentation conventions

- **Diagrams in docs**: use Mermaid (```mermaid code blocks). The Mintlify
  docs site at `docs-site/` renders Mermaid natively. Do not use ASCII art
  for diagrams.

## Commands

```bash
# Install dependencies
pnpm install

# Start all apps in parallel
pnpm dev

# Start individual apps
pnpm dev:site         # Next.js site on :3000
pnpm dev:editor       # Vite editor UI on :4100
pnpm dev:orchestrator # Fastify API on :4200

# Build all workspaces
pnpm build

# TypeScript type checking across all workspaces
pnpm typecheck
```

## Tests

```bash
# Run all tests across monorepo
pnpm test

# Fast unit tests only (orchestrator + blocks)
pnpm test:unit

# E2E tests only (requires API keys)
pnpm test:e2e

# Orchestrator test categories
pnpm --filter @ai-site-editor/orchestrator test:unit         # ~780 pure-function tests, ~17s
pnpm --filter @ai-site-editor/orchestrator test:integration   # ~65 Fastify inject tests, ~12s
pnpm --filter @ai-site-editor/orchestrator test:e2e           # LLM tests, 30s+ (needs API keys)
pnpm --filter @ai-site-editor/orchestrator test:chat          # chat domain subset
pnpm --filter @ai-site-editor/orchestrator test:ops           # ops domain subset
pnpm --filter @ai-site-editor/orchestrator test:nlp           # nlp domain subset

# Run with coverage
pnpm --filter @ai-site-editor/orchestrator coverage
```

Tests use Node's built-in test runner (`node:test`) with `tsx`. Test files live alongside source as `*.test.ts`.

## Architecture

pnpm monorepo — chat-driven website editor with live preview. Core apps + eight packages:

- **apps/orchestrator** (Fastify :4200) — brain: SQLite-backed session state, AI planning, operations engine, publishing
- **apps/editor** (Vite+React :4100) — chat UI, model selection, iframe communication via postMessage
- **apps/site** (Next.js :3000) — renders `BlockInstance` pages, fetches drafts from orchestrator, editor overlay via preview-adapter
- **apps/mcp-server** — MCP server exposing page/block/discovery tools (stdio + HTTP)
- **packages/shared** — Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
- **packages/blocks** — built-in block renderers (Hero, FeatureGrid, Testimonials, FAQAccordion, CTA, Card, CardGrid, RichText, Banner, Carousel, Embed, Footer, Gallery, Quote, SiteHeader, Stats, Table, Tabs, TwoColumn, Video)
- **packages/preview-adapter** — PreviewBridge component, postMessage protocol (`site-editor/v1`), CSS overlay system
- **packages/site-sdk** — SDK for integrating AI editing into any Next.js 15+ site
- **packages/editor-puck** — Puck-based visual drag-and-drop editor
- **packages/migration-sdk** — utilities for migrating existing content into PageDoc/BlockInstance shape
- **packages/immersive-widget** — embeddable widget for immersive block experiences
- **packages/create-ai-site-editor** — CLI scaffolder for new Next.js sites

See `.claude/skills/` for deep architecture, block system, preview-editor, and chat pipeline docs.

## Internationalization (i18n)

Editor UI supports English + German via a custom `LocaleProvider` in `apps/editor/src/i18n/`; locale is forwarded on `/chat` requests so LLM responses match. See `.claude/skills/i18n/SKILL.md` for the full reference (key files, adding a new language, translation rules).

## Environment

Copy `.env.example` to `.env` before running. Key variables:
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — at least one required for AI planning
- `GOOGLE_GENAI_API_KEY` — required when `IMAGE_GEN_PROVIDER=gemini` (the default)
- `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` / `GOOGLE_GENAI_MODEL_*` — override model names per tier (fast/balanced/reasoning/codex)
- `ORCHESTRATOR_URL` — defaults to `http://localhost:4200`
- `IMAGE_GEN_PROVIDER` — AI image backend for variations, `image.generate` tool, and `/image/generate` route. `gemini` (default) or `openai`; falls back if the chosen provider has no API key.
- `VARIATION_DEFAULT_IMAGE_SOURCE` — default image branch for `withDefaultImageVariations` when the message has no provider hint. `unsplash` (default) or `ai` / `gemini` / `openai`. Explicit message keywords always override.
- `OPENAI_IMAGE_MODEL` / `GOOGLE_GENAI_IMAGE_MODEL` — image model overrides (defaults: `gpt-image-1-mini`, `gemini-2.5-flash-image`).
- `AGENT_API_KEY` — enables agentic editing via `/agent/*` routes (Anthropic or OpenAI key).

## Orchestrator persistence

Session state (draft pages, history, version log, chat history, site configs, issue-touched slugs) lives in a single SQLite file managed by `better-sqlite3` (see `apps/orchestrator/src/state/sqlite-store.ts`). Mutations call `schedulePersistState`, which coalesces a request's sync writes via a 30 ms debounce and snapshots every Map into SQLite inside one transaction.

**Files on disk (`.data/`)**
- `orchestrator.db` + `orchestrator.db-wal` + `orchestrator.db-shm` — the live state
- `orchestrator-state.json.migrated-<iso-ts>` — one-shot archive of the legacy JSON writer's output, kept as a safety net and auto-swept after `ORCHESTRATOR_JSON_MIGRATION_TTL_DAYS` (default 14)

**Env vars**
- `ORCHESTRATOR_DB_FILE` — path (empty/unset = default). Auto-switches to `:memory:` under `NODE_ENV=test`; set to the literal `:memory:` to force ephemeral in prod
- `ORCHESTRATOR_STATE_FILE` — legacy JSON read on first boot; the file is renamed after migration, never rewritten
- `ORCHESTRATOR_JSON_MIGRATION_TTL_DAYS` — retention for the archived JSON (default 14)
- `ORCHESTRATOR_DB_BACKUP_INTERVAL_HOURS` — periodic `VACUUM INTO` snapshot interval (default 24)
- `ORCHESTRATOR_DB_BACKUP_LIMIT` — how many rolling `.db.backup-<ts>` snapshots to keep (default 14)

**Caps** — undo/redo stacks are capped at 50 entries per slug + direction; version log at 100; recent edits at 10; chat history at 6 messages. Source of truth: `HISTORY_DEPTH_CAP` / `VERSION_LOG_CAP` / `RECENT_EDITS_CAP` / `CHAT_HISTORY_CAP` in `sqlite-store.ts`; `session-state.ts` re-exports them under the legacy `*_MAX` names. Ephemeral in-memory maps (`pendingApprovalPlanBySession`, `continuationChainBySession`, `publishStatusBySession`, image-source preferences) are **not** persisted.

**Shutdown** — `SIGTERM`/`SIGINT` trigger `app.close()` (drain in-flight handlers) → `persistStateNow` (flush any debounced write) → `resetStore()` (checkpoint the WAL) in that order.

**Native dependency** — `better-sqlite3` ships prebuilt binaries for linux-x64 (glibc 2.28+), darwin-arm64, and darwin-x64 with Node 22. Render's default buildpack works out of the box. Custom Dockerfiles need `python3`, `make`, and `g++` on the build stage only if the prebuild is missing for your target glibc / musl.

## Chat Pipeline Flags

The orchestrator's chat pipeline reads ~16 `CHAT_*` env vars (parallel planner, router head-start, deferred image resolution, streamed op apply, auto-reasoning, adaptive schema context, etc.). Defaults are tuned for responsiveness — disable individually when debugging. See `.claude/skills/chat-pipeline/SKILL.md` § Environment Flags for the full table.
