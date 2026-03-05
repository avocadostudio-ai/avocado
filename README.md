# AI Site Editor PoC

Local monorepo PoC for chat-driven website editing with instant preview updates.

## Apps

- `apps/site` Next.js website renderer on `http://localhost:3000`
- `apps/editor` Vite editor UI on `http://localhost:4100`
- `apps/orchestrator` Fastify API on `http://localhost:4200`
- `packages/shared` Shared types, schemas, registry, and edit-plan validation

## Run

1. Install pnpm and dependencies:
   - `pnpm install`
2. Copy env template if needed:
   - `cp .env.example .env`
3. Start all apps:
   - `pnpm dev`

Alternative (recommended for repeated restarts without opening new terminals):
- `pnpm dev:start` — start managed singleton dev stack in background
- `pnpm dev:ctl start --wait --timeout 90` — start and block until all services are healthy
- `pnpm dev:status` — check status/pid/log path
- `pnpm dev:restart` — restart same managed stack
- `pnpm dev:logs` — tail combined logs
- `pnpm dev:doctor` — print PID tree, listeners, health checks, and recent logs
- `pnpm dev:stop` — stop managed stack

## Key endpoints

- `GET /draft/pages?session=dev&slug=/`
- `POST /chat`
- `GET /telemetry/chat`
- `GET /telemetry/chat/review`
- `POST /audio/transcribe` (multipart field: `audio`)
- `POST /history/undo`
- `POST /history/redo`

## Notes

- Next.js onboarding default is embedded Draft Mode (no required `/preview` route):
  - `docs/integration/nextjs-mvp-embedded.md`
  - `docs/integration/nextjs-mvp-adoption-example.md`
- Editor URL/bootstrap quickstart:
  - `docs/integration/editor-quickstart.md`
- Copy-paste Next.js API route templates:
  - `docs/integration/templates/nextjs-embedded/`
  - includes MVP component manifest route (`/api/editor/components`)
- If `OPENAI_API_KEY` is missing, `/chat` uses deterministic demo planning.
- `CHAT_STRICT_PRIMARY_OP_MODE=1` makes `/chat` planner choose one primary operation in `ops` (strict mode).
- Speech transcription model defaults to `gpt-4o-mini-transcribe`.
- Configure transcription model order with:
  - `OPENAI_TRANSCRIBE_MODEL` (primary)
  - `OPENAI_TRANSCRIBE_FALLBACK_MODELS` (comma-separated, tried in order when primary fails)
- Optional Unsplash search for hero image requests:
  - `UNSPLASH_ACCESS_KEY` (if set, orchestrator uses Unsplash Search API; otherwise it falls back to a deterministic Picsum URL to avoid broken `source.unsplash.com` links)
- Site preview refresh is triggered by editor `postMessage` with `draftUpdated`.
- Chat troubleshooting playbook:
  - `docs/observability/chat-behavior-troubleshooting.md`
- Dev server runbook (start/restart/status/logs/health checks):
  - `docs/operations/dev-server-runbook.md`
- Product improvement backlog:
  - `docs/planning/things-to-improve.md`
- Editor debug mode:
  - Enable in Settings -> `Debug mode` to show trace/debug data per assistant response.
  - Optional default-on via `VITE_CHAT_DEBUG=1`.

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
  - `NEXT_PUBLIC_EDITOR_ORIGIN=https://<editor-host>`
- Editor:
  - `VITE_SITE_ORIGIN=https://<site-host>`
  - `VITE_ORCHESTRATOR_URL=https://<orchestrator-host>`
  - `VITE_PUBLISH_TOKEN=<same as orchestrator PUBLISH_TOKEN>` (if publish auth enabled)
