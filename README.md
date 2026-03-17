# AI Site Editor

Chat-driven website editing platform. Users describe content and layout changes in natural language, and the system applies them as validated structured operations with live preview.

**For site owners and external developers**: see [Integration docs](docs/integration/README.md) to connect the editor to your site.

## What is this?

AI Site Editor is a split-pane editing experience:
- **Left**: live site preview (your actual website in an iframe)
- **Right**: chat interface where users request edits in plain English

Changes are applied as validated, schema-checked operations (not raw code edits), with full undo/redo and plan approval support. The system supports OpenAI and Anthropic models, with a deterministic fallback when no API key is configured.

## Architecture

pnpm monorepo with three apps and shared packages:

| App / Package | Stack | Port | Purpose |
|---|---|---|---|
| `apps/site` | Next.js | `:3000` | Renders pages from content JSON; editor preview target |
| `apps/editor` | Vite + React | `:4100` | Chat UI, model selection, iframe preview host |
| `apps/orchestrator` | Fastify | `:4200` | AI planning, operation engine, state, undo/redo, publish |
| `packages/shared` | TypeScript | — | Zod schemas, block registry, shared types |
| `packages/blocks` | React | — | Block renderer components |
| `packages/preview-adapter` | TypeScript + React | — | postMessage bridge, CSS overlay, selection system |

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- **OpenAI API key** or **Anthropic API key** (optional — without one, the system uses deterministic demo planning)

## Quick start

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Copy and configure environment:
   ```bash
   cp .env.example .env
   # Edit .env — at minimum set OPENAI_API_KEY or ANTHROPIC_API_KEY for AI planning
   ```
3. Start all apps:
   ```bash
   pnpm dev
   ```
4. Open the editor at `http://localhost:4100`

### Managed dev stack (recommended for repeated restarts)

```bash
pnpm dev:start          # start background dev stack
pnpm dev:status         # check status/pid/log path
pnpm dev:restart        # restart same managed stack
pnpm dev:logs           # tail combined logs
pnpm dev:doctor         # print PID tree, listeners, health checks, and recent logs
pnpm dev:stop           # stop managed stack
```

## Key endpoints (orchestrator on :4200)

- `GET /draft/pages?session=dev&slug=/`
- `POST /chat`
- `GET /telemetry/chat`
- `GET /telemetry/chat/review`
- `POST /audio/transcribe` (multipart field: `audio`)
- `POST /history/undo`
- `POST /history/redo`

## Integrating your site

If you want to connect the AI editor to your own website, start here:

### Supported now (MVP)

| Doc | Purpose |
|---|---|
| [Integration overview](docs/integration/README.md) | Entry point, adoption checklist, SDK overview |
| [Next.js embedded mode](docs/integration/nextjs-mvp-embedded.md) | 30-minute setup with `@ai-site-editor/site-sdk` |
| [Adoption example](docs/integration/nextjs-mvp-adoption-example.md) | Full code example for page wiring |
| [Editor quickstart](docs/integration/editor-quickstart.md) | Draft mode URLs and behavior checks |
| [Native tools](docs/integration/tools-mvp.md) | Register custom tools (PIM, DAM, etc.) |

**MVP scope:** Next.js 15+ with App Router. The `@ai-site-editor/site-sdk` package provides handler factories for all required API routes, draft context resolution, content fetching, and editor overlay components. 12 block types are available out of the box (Hero, FeatureGrid, Testimonials, FAQ, CTA, Card, CardGrid, RichText, Stats, ContactForm, TwoColumn, Footer).

### Planned (not yet implemented)

| Doc | Purpose |
|---|---|
| [Site Provider SPI](docs/integration/site-provider-spi.md) | Framework-agnostic REST API contract for Remix, Nuxt, SvelteKit, custom stacks |

The SPI defines a standard REST contract (`GET /pages`, `PUT /pages/{id}/content`, etc.) that will allow non-Next.js sites to integrate. This is documented as a target design but not yet wired into the orchestrator.

Pages Router support is not available — the SDK uses App Router APIs (`draftMode()` from `next/headers`).

### For dev teams using AI coding tools

| Doc | Purpose |
|---|---|
| [Adoption guide for AI agents](docs/integration/ai-coding-agents-adoption.md) | Paste into your agent's context to integrate AI Site Editor into your site |
| [Contributing guide for AI agents](docs/integration/ai-coding-agents.md) | For agents working on the AI Site Editor codebase itself |

### Reference

| [All docs](docs/README.md) | Full documentation index |

## Configuration notes

- If `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are both missing, `/chat` uses deterministic demo planning.
- `CHAT_STRICT_PRIMARY_OP_MODE=1` makes the planner choose one primary operation per request.
- `UNSPLASH_ACCESS_KEY` enables Unsplash image search; without it, hero images use Picsum placeholders.
- Speech transcription defaults to `gpt-4o-mini-transcribe`. Configure with `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_TRANSCRIBE_FALLBACK_MODELS`.
- Editor debug mode: enable in Settings or set `VITE_CHAT_DEBUG=1`.

## Further reading

- [Chat troubleshooting playbook](docs/observability/chat-behavior-troubleshooting.md)
- [Dev server runbook](docs/operations/dev-server-runbook.md)
- [Avocado transformation demo runbook](docs/testing/avocado-transformation-demo-runbook.md)
- `pnpm demo:avocado:check` (demo preflight verification)
- `pnpm demo:60s:human` (headed, humanized Playwright demo run)
- [Product improvement backlog](docs/planning/things-to-improve.md)

## Planner Command Test Set

- Complete command coverage prompt set:
  - `apps/orchestrator/src/scripts/test-sets/all-commands.json`
  - Includes `expectedOps` labels for automatic command accuracy scoring (exact match, F1, recall, precision).
- Run with mini model first:
  - `pnpm -C apps/orchestrator benchmark:models --model gpt-4o-mini --runs 1 --prompts src/scripts/test-sets/all-commands.json --out ../../.data/model-benchmark-all-commands-mini.json`
- Run with structured op evaluation (recommended):
  - `pnpm -C apps/orchestrator benchmark:models --model gpt-4o-mini --runs 1 --eval-mode ops-json --prompts src/scripts/test-sets/all-commands.json --out ../../.data/model-benchmark-all-commands-mini-ops-json.json`
- Run with another model (configurable):
  - `pnpm -C apps/orchestrator benchmark:models --model gpt-5 --runs 1 --prompts src/scripts/test-sets/all-commands.json --out ../../.data/model-benchmark-all-commands-gpt5.json`
- Multi-model comparison:
  - `pnpm -C apps/orchestrator benchmark:models --models \"gpt-4o-mini,gpt-4o,gpt-5\" --runs 1 --prompts src/scripts/test-sets/all-commands.json --out ../../.data/model-benchmark-all-commands-multi.json`

## Deployment

- Vercel deployment plan: `docs/operations/vercel-deployment.md`

### Public site on Vercel (current-ready path)

Deploy only `apps/site` as the Vercel project.

- Root Directory: `apps/site`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm --filter @ai-site-editor/site build`

Environment variables:

- `ORCHESTRATOR_URL` (optional): if set, site reads draft content from orchestrator; if missing or unavailable, site falls back to built-in published pages.
- `SITE_RENDER_MODE` (`static` or `dynamic`): controls whether this route prebuilds known published slugs (`static`) or skips static slug generation (`dynamic`).
- `SITE_PUBLISH_SESSION` (default `dev`): session that static build sync pulls from orchestrator.
- `SITE_PUBLISH_SITE_ID` (required when `ORCHESTRATOR_URL` is set): site namespace used for `/publish/content` sync.
- `DRAFT_MODE_SECRET` (required for draft preview entry via `/api/draft`)
- `NEXT_PUBLIC_ENABLE_EDITOR=0` (recommended for public site)
- `NEXT_PUBLIC_EDITOR_ORIGIN` (optional; only relevant when editor mode is enabled)
- `PUBLISH_MODE` (`git` or `deploy_hook`) on orchestrator
- `PUBLISH_GIT_BRANCH` (default `main`) on orchestrator
- `PUBLISH_GIT_STRICT` (`1` to require clean tree before publish) on orchestrator
- `PUBLISH_TOKEN` on orchestrator and `VITE_PUBLISH_TOKEN` in editor (optional auth)
- `VERCEL_DEPLOY_HOOK_URL` only for `PUBLISH_MODE=deploy_hook`
- `ORCHESTRATOR_CORS_ORIGINS` (comma-separated): required for hosted orchestrator; include deployed `site` and `editor` origins
- `VITE_SITE_ORIGIN` in editor build (for iframe target)
- `VITE_SITE_DRAFT_SECRET` in editor build (must match site `DRAFT_MODE_SECRET` for draft bootstrap)
- `VITE_ORCHESTRATOR_URL` in editor build (for API requests)

Recommended Vercel split:

- Production env:
  - `SITE_RENDER_MODE=static`
  - `NEXT_PUBLIC_ENABLE_EDITOR=0`
  - `ORCHESTRATOR_URL` unset
- Preview env:
  - `SITE_RENDER_MODE=dynamic`
  - `NEXT_PUBLIC_ENABLE_EDITOR=1`
  - `ORCHESTRATOR_URL=https://<preview-orchestrator-host>`

Note: a dedicated preview route/project is optional. MVP onboarding supports embedded mode without requiring `/preview` paths.

### Publish flow (editor -> Vercel)

1. Editor calls `POST /publish` on orchestrator.
2. In `PUBLISH_MODE=git`, orchestrator writes `apps/site/lib/published-content.json`, commits, and pushes `main`.
3. Vercel deploys from git and the static site includes that published snapshot.
4. In `PUBLISH_MODE=deploy_hook` (phase 2), orchestrator triggers `VERCEL_DEPLOY_HOOK_URL` and Vercel build pulls `/publish/content`.

### Full demo deployment (site + editor + orchestrator)

To run the full demo publicly (not only local), deploy all three apps:

1. `apps/site` on Vercel.
2. `apps/orchestrator` on a long-running host (Render/Fly/Railway/VM).
3. `apps/editor` on Vercel or static hosting.

Required settings:

- Orchestrator:
  - `OPENAI_API_KEY`
  - `ORCHESTRATOR_PUBLIC_ORIGIN=https://<orchestrator-host>`
  - `ORCHESTRATOR_CORS_ORIGINS=https://<site-host>,https://<editor-host>`
  - `PUBLISH_MODE=git`
  - `PUBLISH_GIT_BRANCH=<deployment-branch>`
- Site:
  - `ORCHESTRATOR_URL=https://<orchestrator-host>` (preview/editor mode)
  - `NEXT_PUBLIC_ENABLE_EDITOR=1` (for demo environments)
  - `NEXT_PUBLIC_EDITOR_ORIGIN=https://<editor-host>` (no trailing slash)
  - `DRAFT_MODE_SECRET=<shared-secret>` (required for draft preview entry)
- Editor:
  - `VITE_SITE_ORIGIN=https://<site-host>`
  - `VITE_SITE_DRAFT_SECRET=<shared-secret>` (must match site `DRAFT_MODE_SECRET`)
  - `VITE_ORCHESTRATOR_URL=https://<orchestrator-host>`
  - `VITE_PUBLISH_TOKEN=<same as orchestrator PUBLISH_TOKEN>` (if publish auth enabled)

**Important:** Origin env vars (`NEXT_PUBLIC_EDITOR_ORIGIN`, `VITE_SITE_ORIGIN`, `ORCHESTRATOR_CORS_ORIGINS`) must **not** have a trailing slash. `event.origin` in postMessage never includes a trailing slash, so a mismatch silently drops all messages.
