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
- `OPENAI_API_KEY` — required for real AI planning; omit for demo mode
- `OPENAI_MODEL_*` — override model names per tier (fast/balanced/reasoning/codex)
- `ORCHESTRATOR_URL` — defaults to `http://localhost:4200`
