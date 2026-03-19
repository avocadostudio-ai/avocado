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
# Run all tests across monorepo
pnpm test

# Fast unit tests only (orchestrator + blocks)
pnpm test:unit

# E2E tests only (requires API keys)
pnpm test:e2e

# Orchestrator test categories
pnpm --filter @ai-site-editor/orchestrator test:unit         # ~28 pure-function tests, <2s
pnpm --filter @ai-site-editor/orchestrator test:integration   # ~4 Fastify inject tests, <3s
pnpm --filter @ai-site-editor/orchestrator test:e2e           # ~2 LLM tests, 30s+ (needs API keys)
pnpm --filter @ai-site-editor/orchestrator test:chat          # chat domain subset
pnpm --filter @ai-site-editor/orchestrator test:ops           # ops domain subset
pnpm --filter @ai-site-editor/orchestrator test:nlp           # nlp domain subset

# Run with coverage
pnpm --filter @ai-site-editor/orchestrator coverage
```

Tests use Node's built-in test runner (`node:test`) with `tsx`. Test files live alongside source as `*.test.ts`.

## Architecture

pnpm monorepo — chat-driven website editor with live preview. Three apps + two packages:

- **apps/orchestrator** (Fastify :4200) — brain: in-memory session state, AI planning, operations engine, publishing
- **apps/editor** (Vite+React :4100) — chat UI, model selection, iframe communication via postMessage
- **apps/site** (Next.js :3000) — renders `BlockInstance` pages, fetches drafts from orchestrator, editor overlay via preview-adapter
- **packages/shared** — Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
- **packages/blocks** — block renderers (Hero, FeatureGrid, Testimonials, FAQAccordion, CTA, Card, CardGrid, RichText)
- **packages/preview-adapter** — PreviewBridge component, postMessage protocol (`site-editor/v1`), CSS overlay system

See `.claude/skills/` for deep architecture, block system, preview-editor, and chat pipeline docs.


## Environment

Copy `.env.example` to `.env` before running. Key variables:
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — at least one required for AI planning; omit both for demo mode
- `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` — override model names per tier (fast/balanced/reasoning/codex)
- `ORCHESTRATOR_URL` — defaults to `http://localhost:4200`

### Chat Pipeline Flags

Responsiveness optimizations — all default **on** (`1`). Set to `0` to disable.

| Flag | Default | Description |
|------|---------|-------------|
| `CHAT_PARALLEL_PLANNER` | `1` | Launch intent router and full LLM planner concurrently. Router gets a head-start; if it succeeds the full planner is aborted. Saves 500-1000ms when the router misses. |
| `CHAT_ROUTER_HEAD_START_MS` | `200` | Milliseconds the fast intent router runs before the full planner starts (0-1000). Higher = more API cost savings when router succeeds; lower = faster fallback. |
| `CHAT_DEFER_IMAGE_RESOLUTION` | `1` | Apply text/structural ops immediately, then resolve images (Unsplash/DALL-E) in the background. Images patch in via follow-up SSE events. Avoids 1-15s blocking. |
| `CHAT_STREAMED_OP_APPLY` | `1` | Validate and apply each op as it streams from the LLM, instead of waiting for the full plan. User sees changes at ~800ms intervals. Rolls back on failure. |
| `CHAT_LLM_INTENT_ROUTER` | `1` | Enable the fast-model intent router before the full planner. |
| `CHAT_INCREMENTAL_APPLY` | `1` | Apply ops one-by-one with preview version bumps (progressive UI updates). |
| `CHAT_INCREMENTAL_PLAN_STREAM` | `1` | Stream op candidates to the editor as they parse from the LLM JSON. |
| `CHAT_STREAM_APPLY_MIN_STEP_MS` | `260` | Minimum ms between progressive op-applied events (paces UI animation). |

Other chat flags (default **off**):

| Flag | Default | Description |
|------|---------|-------------|
| `CHAT_STRICT_PRIMARY_OP_MODE` | `0` | Force single-op plans (one operation per message). |
| `CHAT_STRICT_JSON_RESPONSE` | `0` | Use OpenAI structured outputs for strict JSON schema validation. |
| `CHAT_ADAPTIVE_SCHEMA_CONTEXT` | `0` | Dynamically select which block contracts to include based on message content. |
| `CHAT_SCHEMA_BUDGET_BYTES` | `9000` | Max bytes for adaptive schema context payload. |
| `CHAT_COMPACT_CONTEXT_EXPERIMENT` | `0` | Compact the planner context pack to reduce token usage. |
| `CHAT_MINIMAL_CONTEXT_EXPERIMENT` | `0` | Strip context pack to bare minimum for simple edits. |
