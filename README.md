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
- `POST /audio/transcribe` (multipart field: `audio`)
- `POST /history/undo`
- `POST /history/redo`

## Notes

- If `OPENAI_API_KEY` is missing, `/chat` uses deterministic demo planning.
- Speech transcription model defaults to `gpt-4o-mini-transcribe`.
- Configure transcription model order with:
  - `OPENAI_TRANSCRIBE_MODEL` (primary)
  - `OPENAI_TRANSCRIBE_FALLBACK_MODELS` (comma-separated, tried in order when primary fails)
- Optional Unsplash search for hero image requests:
  - `UNSPLASH_ACCESS_KEY` (if set, orchestrator uses Unsplash Search API; otherwise it falls back to a deterministic Picsum URL to avoid broken `source.unsplash.com` links)
- Site preview refresh is triggered by editor `postMessage` with `draftUpdated`.

## Deployment

- Vercel deployment plan: `docs/vercel-deployment.md`

### Public site on Vercel (current-ready path)

Deploy only `apps/site` as the Vercel project.

- Root Directory: `apps/site`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm --filter @ai-site-editor/site build`

Environment variables:

- `ORCHESTRATOR_URL` (optional): if set, site reads draft content from orchestrator; if missing or unavailable, site falls back to built-in published pages.
- `SITE_RENDER_MODE` (`static` or `dynamic`): controls whether this route prebuilds known published slugs (`static`) or skips static slug generation (`dynamic`).
- `SITE_PUBLISH_SESSION` (default `dev`): session that static build sync pulls from orchestrator.
- `NEXT_PUBLIC_ENABLE_EDITOR=0` (recommended for public site)
- `NEXT_PUBLIC_EDITOR_ORIGIN` (optional; only relevant when editor mode is enabled)
- `PUBLISH_MODE` (`git` or `deploy_hook`) on orchestrator
- `PUBLISH_GIT_BRANCH` (default `main`) on orchestrator
- `PUBLISH_GIT_STRICT` (`1` to require clean tree before publish) on orchestrator
- `PUBLISH_TOKEN` on orchestrator and `VITE_PUBLISH_TOKEN` in editor (optional auth)
- `VERCEL_DEPLOY_HOOK_URL` only for `PUBLISH_MODE=deploy_hook`

Recommended Vercel split:

- Production env:
  - `SITE_RENDER_MODE=static`
  - `NEXT_PUBLIC_ENABLE_EDITOR=0`
  - `ORCHESTRATOR_URL` unset
- Preview env:
  - `SITE_RENDER_MODE=dynamic`
  - `NEXT_PUBLIC_ENABLE_EDITOR=1`
  - `ORCHESTRATOR_URL=https://<preview-orchestrator-host>`

Note: if you need true force-dynamic SSR on every request for preview/editor, use a separate preview app/project variant with route config `export const dynamic = "force-dynamic"`.

### Publish flow (editor -> Vercel)

1. Editor calls `POST /publish` on orchestrator.
2. In `PUBLISH_MODE=git`, orchestrator writes `apps/site/lib/published-content.json`, commits, and pushes `main`.
3. Vercel deploys from git and the static site includes that published snapshot.
4. In `PUBLISH_MODE=deploy_hook` (phase 2), orchestrator triggers `VERCEL_DEPLOY_HOOK_URL` and Vercel build pulls `/publish/content`.
