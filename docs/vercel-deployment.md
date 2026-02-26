# Vercel Deployment Plan (Self-Hosted)

This document summarizes the changes needed to publish this project on Vercel.

## Current decision (Feb 25, 2026)

Current scope is **Phase 1 only: public site on Vercel**.

Phase 2 (editor + orchestrator on Vercel) is explicitly deferred.

### Required now (Phase 1)

1. `apps/site` must render published content without requiring orchestrator at runtime.
2. Add production fallback so site never fails to render if orchestrator is unavailable.
3. Disable or protect `__editor=1` in production.
4. Deploy only `apps/site` as a single Vercel project.

## Current architecture (from this repo)

- `apps/site` is a Next.js app.
- `apps/orchestrator` is a Fastify API with in-memory state + file persistence (`.data/orchestrator-state.json`).
- `apps/editor` is a Vite app that currently hard-codes local URLs.
- The site currently reads **draft** content from `ORCHESTRATOR_URL` (`/draft/pages`, `/draft/slugs`).

## Important decision first

Pick one deployment target:

1. Public website only (recommended for launch)
2. Full editor + orchestration stack on Vercel

---

## 1) Public website only (recommended)

Use this if you want a stable public site and do not need live editing in production.

### Required changes

1. Decouple `apps/site` from draft API at runtime.
- Today, `apps/site` fetches draft pages from orchestrator.
- For production, render from a published source (shared seed content, JSON, CMS, or database).
- Keep orchestrator integration optional (for dev/editor mode only).

2. Add a published content source for site rendering.
- Option A: Use `demoPublishedPages()` from `packages/shared` as initial published content.
- Option B: Load from a real storage backend (recommended long term).

3. Add production fallback behavior.
- If orchestrator is unavailable, site should still render published pages (not `Page not found`).

4. Restrict or disable editor mode in production.
- `__editor=1` should be disabled or protected.
- Avoid exposing editor bridge behavior publicly by default.

### Vercel config

Create one Vercel project for `apps/site`:
- Root Directory: `apps/site`
- Install Command: `pnpm install --frozen-lockfile`
- Build Command: `pnpm --filter @ai-site-editor/site build`
- Output: Next.js default

### Environment variables (site)

- `ORCHESTRATOR_URL` (optional in public-only mode; required only if you keep remote draft fetches)
- `NEXT_PUBLIC_EDITOR_ORIGIN` (optional; only if editor mode is enabled)

---

## 2) Full editor stack on Vercel (site + orchestrator + optional editor)

Use this only if you want production editing workflows.

### Required code changes

1. Remove hard-coded local origins from `apps/editor/src/App.tsx`.
- Replace:
  - `editorOrigin = "http://localhost:4100"`
  - `siteOrigin = "http://localhost:3000"`
  - `orchestrator = "http://localhost:4200"`
- With Vite env vars (`import.meta.env.VITE_*`).

2. Remove hard-coded local defaults in `apps/site`.
- `DEFAULT_EDITOR_ORIGIN` should come from env (`NEXT_PUBLIC_EDITOR_ORIGIN`) instead of `http://localhost:4100`.
- Keep `ORCHESTRATOR_URL` required for editor-enabled production.

3. Rework orchestrator persistence.
- Current implementation relies on in-memory Maps + filesystem persistence.
- Vercel functions are ephemeral; local file persistence is not durable.
- Move state to durable storage (Postgres, Redis/KV, etc.).

4. Rework orchestrator runtime model for Vercel.
- Current API starts a standalone server via `app.listen(...)`.
- For Vercel, expose request handlers/functions instead of long-running process assumptions.

5. Tighten CORS in orchestrator.
- Current CORS is `origin: true` (too open for production).
- Restrict to known site/editor origins via env-based allowlist.

6. Review streaming endpoint behavior (`/chat/stream`).
- Ensure it fits your Vercel function execution limits and plan.
- Add fallback to non-streaming `/chat` if needed.

### Vercel projects

Set up separate projects:

1. `site` project (Next.js)
- Root: `apps/site`
- Env: `ORCHESTRATOR_URL`, `NEXT_PUBLIC_EDITOR_ORIGIN` (if used)

2. `orchestrator` project (API)
- Root: `apps/orchestrator`
- Env: `OPENAI_API_KEY`, model env vars, storage connection env vars, CORS allowlist

3. `editor` project (optional)
- Root: `apps/editor`
- Env: `VITE_EDITOR_ORIGIN`, `VITE_SITE_ORIGIN`, `VITE_ORCHESTRATOR_URL`

---

## Minimal change list before first Vercel publish

If the goal is to publish quickly, do these first:

1. Implement published rendering path in `apps/site` that does not require orchestrator.
2. Disable/protect production editor mode.
3. Deploy `apps/site` only on Vercel.

Then add orchestrator/editor deployment as phase 2.

## Deferred (Phase 2, later)

- Deploy `apps/orchestrator` on Vercel-compatible runtime.
- Move orchestrator state to durable external storage.
- Migrate editor/site/orchestrator origins to env-only configuration.
- Lock CORS to explicit allowlist.
- Deploy `apps/editor` (if production editing is required).

---

## Suggested rollout plan

1. Phase 1: Public site only on Vercel (stable, low risk)
2. Phase 2: Externalize orchestrator state storage
3. Phase 3: Deploy orchestrator + editor with locked CORS and env-driven origins
