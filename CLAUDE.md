# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
# Run all tests (orchestrator)
pnpm test

# Run orchestrator tests directly
pnpm --filter @ai-site-editor/orchestrator test

# Run with coverage
pnpm --filter @ai-site-editor/orchestrator coverage
```

Tests use Node's built-in test runner (`node:test`) with `tsx`. Test files live alongside source as `*.test.ts`.

## Architecture

This is a pnpm monorepo implementing a **chat-driven website editor with live preview**. Three apps communicate to provide an AI-assisted editing workflow:

```
Editor UI (4100) ←→ Orchestrator API (4200) ←→ Site Renderer (3000)
```

### apps/orchestrator (Fastify backend — core logic lives here)

The orchestrator is the brain of the system. It holds all session state in-memory:
- `publishedPages` — immutable baseline
- `draftPages` — session-specific edits keyed by `session`
- `historyUndo` / `historyRedo` — per-session undo/redo stacks

Key endpoints:
- `GET /draft/pages?session=&slug=` — fetch draft page for preview
- `POST /chat` — convert user message to an `EditPlan` via OpenAI or demo planner
- `POST /history/undo` / `POST /history/redo`

If `OPENAI_API_KEY` is absent, `/chat` falls back to a deterministic demo planner.

### apps/editor (Vite + React 19 — chat UI)

Chat interface that sends messages to `/chat`, receives `EditPlan` responses, and renders the site in an iframe. Manages model selection (fast/balanced/reasoning/codex) and undo/redo buttons. Communicates with the iframe via `postMessage`.

### apps/site (Next.js 15 — site renderer)

Renders pages composed of `BlockInstance` objects. Fetches draft pages from orchestrator on each request. Activates editor mode when `?__editor=1` is present, exposing block selection/highlight UI via the `preview-adapter` package.

### packages/shared (types & schemas)

Zod schemas are the source of truth for all data structures:
- `PageDoc` — a page with an array of `BlockInstance`
- `BlockInstance` — `{ id, type, props }` where `type` maps to a registered block
- `Operation` — discriminated union of edit operations: `create_page`, `add_block`, `update_props`, `remove_block`, `move_block`
- `EditPlan` — AI planner output: `{ intent, summary, changelog, operations[] }`

Registered block types: `Hero`, `FeatureGrid`, `Testimonials`, `FAQAccordion`, `CTA`, `Card`, `CardGrid`, `RichText`

### packages/preview-adapter

React component (`PreviewBridge`) and helpers that the site app uses to wire up block selection. Handles `postMessage` protocol (`site-editor/v1`) between site iframe and editor:
- Outbound: `blockClicked`, `routeChanged`, `blockReordered`, `blockDeleteRequested`
- Inbound: `highlightBlock`, `draftUpdated`

Blocks are tagged with `data-editable-target` and `data-editable-label` attributes.

## Environment

Copy `.env.example` to `.env` before running. Key variables:
- `OPENAI_API_KEY` — required for real AI planning; omit for demo mode
- `OPENAI_MODEL_*` — override model names per tier (fast/balanced/reasoning/codex)
- `ORCHESTRATOR_URL` — defaults to `http://localhost:4200`
