# Current State Snapshot

Date: 2026-02-26

## Live deployment status
- Public site is deployed on Vercel (static build output from committed published content).
- Production renders from committed published content, not from live local draft APIs.

## Phase 1 publish model (implemented)
- Publish mode: `git` (recommended for current local-only orchestrator).
- Orchestrator `/publish` writes session pages to:
  - `apps/site/lib/published-content.json`
- Orchestrator then runs git flow:
  - `git add apps/site/lib/published-content.json`
  - `git commit -m "publish: session ..."`
  - `git push origin <branch>`
- Vercel deploy is triggered by the push to the connected branch.

## Why this works now
- Orchestrator is local only, so Vercel cannot call it directly during production build/runtime.
- Git-driven publishing moves edited content into the repository itself, which Vercel can always build from.

## Site rendering behavior
- In editor mode (`__editor=1`): the site tries strict draft fetch from orchestrator.
  - If orchestrator draft is unavailable, it shows "Draft unavailable".
- In public mode: the site falls back to published content JSON.
- The catch-all page route uses dynamic/no-store behavior for preview/editor correctness.

## Environment variables in use
- Orchestrator:
  - `PUBLISH_MODE=git`
  - `PUBLISH_GIT_BRANCH=main`
  - `PUBLISH_GIT_STRICT` (optional)
  - `PUBLISH_TOKEN` (optional header guard for `/publish`)
  - `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (optional for deployment status polling)
- Site:
  - `ORCHESTRATOR_URL` is optional for public production path.

## Recent code commit for Phase 1
- Commit: `040ba82`
- Message: `feat(publish): phase1 git-driven vercel publish flow`
- Files:
  - `apps/orchestrator/src/index.ts`
  - `apps/site/app/[[...slug]]/page.tsx`
  - `apps/site/lib/content-api.ts`

## Known limitations
- Multi-editor conflict handling is not finalized yet (publish races and merge policy still pending design).
- Many unrelated local workspace changes are currently uncommitted; branch hygiene is manual for now.
- No chat-based publish trigger yet (planned later).

## Phase 2 direction (not implemented yet)
- Host orchestrator on a stable remote runtime with durable storage.
- Add API-hosted publish mode with secure webhook/trigger path.
- Add explicit conflict resolution strategy for concurrent editors.
