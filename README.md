# AI Site Editor

Chat-driven website editor with live preview. Users describe changes in natural language — the system plans and applies structured, schema-validated edits with undo/redo and plan approval.

**How it works**: split-pane UI with your live site on the left and a chat interface on the right. Type requests like _"add a testimonials section below the hero"_ or _"change the heading to Welcome"_ and see changes applied in real time.

## Quickstart

**Prerequisites**: Node.js 22+ and [corepack](https://nodejs.org/api/corepack.html) enabled.

```bash
# 1. Enable corepack (provides pnpm at the pinned version)
corepack enable

# 2. Install dependencies
pnpm install

# 3. Set up environment
pnpm dev:setup

# 4. Start all services
pnpm dev:start
```

Then open:

| Service       | URL                      |
|---------------|--------------------------|
| Site          | http://localhost:3000     |
| Editor        | http://localhost:4100     |
| Orchestrator  | http://localhost:4200     |

Open the **Editor** at `http://localhost:4100` to start chatting with your site.

### Environment

`pnpm dev:setup` copies `.env.example` to `.env` and prompts for an API key. You need **at least one** of:

- `ANTHROPIC_API_KEY` — for Claude models
- `OPENAI_API_KEY` — for OpenAI models

Omit both to run in **demo mode** (pre-recorded plans, no LLM calls).

### Managed dev servers

```bash
pnpm dev:start    # Start all 3 services (backgrounded)
pnpm dev:stop     # Stop all services
pnpm dev:restart  # Restart all services
pnpm dev:status   # Check if running
pnpm dev:logs     # Tail combined logs
pnpm dev:doctor   # Diagnose port/process issues
```

Or run in the foreground: `pnpm dev`

## Architecture

pnpm monorepo with 3 apps and 3 packages:

```
apps/
  orchestrator/  — Fastify API (:4200) — sessions, AI planning, ops engine, publishing
  editor/        — Vite + React (:4100) — chat UI, model picker, iframe bridge
  site/          — Next.js (:3000) — renders pages from BlockInstance data
packages/
  shared/        — Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
  blocks/        — Block renderers (Hero, FeatureGrid, Testimonials, FAQ, CTA, Card, RichText)
  preview-adapter/ — PreviewBridge component, postMessage protocol, CSS overlay system
```

## Development

```bash
# TypeScript type checking across all workspaces
pnpm typecheck

# Run all tests
pnpm test

# Fast unit tests only (~2s)
pnpm test:unit

# E2E tests (requires API keys, ~30s)
pnpm test:e2e

# Build all workspaces
pnpm build
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and environment variable documentation.
