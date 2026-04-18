# OSS Launch Punch List

Deferred hardening and polish items to land before (or shortly after) the first public announcement. Items are ranked by severity, not chronology — tackle in whatever order is convenient, but everything here should be done before the HN / Twitter / PH push.

Each item points at a more detailed plan where one exists. This file is the index.

---

## Must-have (before announcement)

### 1. CI gate for distributed contributors

**Status:** deferred. **Plan:** [`ci-split-gates.md`](./ci-split-gates.md).

Re-enable `.github/workflows/planner-eval.yml.disabled` as two separate workflows: a secrets-free PR gate (typecheck + unit + integration) that runs on fork PRs, and a full `main` gate (adds e2e + planner eval) that runs post-merge with API-key secrets. Biggest OSS-readiness risk we have — first wave of contributor PRs will hit this immediately.

**Effort:** ~1 day.

### 2. Semver / stability discipline

**Status:** deferred. **Plan:** [`semver-stability.md`](./semver-stability.md).

Define stability tiers (Stable / Experimental / Internal), write `STABILITY.md`, mark public APIs with `@experimental` / `@deprecated` / `@internal` JSDoc, decide npm-public vs GitHub-Packages per package. Prevents contributors making assumptions we can't walk back.

**Effort:** ~0.5–1 day.

---

## Should-have (soon after announcement)

### 3. Move demo-mode enforcement to middleware

**Status:** deferred. **Context:** OSS-readiness review, 2026-04-18.

Today demo-mode gate checks are embedded inside business-logic functions:
- `applyOpsAtomically` (in `apps/orchestrator/src/ops/ops-engine.ts`) — op-level allow-list enforcement
- `detectImageOps` (in the chat pipeline) — image-generation short-circuit

This leaks demo concerns into core paths. Consumers who aren't running a public demo still pay the cost of reading `isDemoMode()` everywhere, and forking the orchestrator to remove demo logic is harder than it should be.

**Target shape:** Fastify-level middleware that wraps `/chat*` and `/ops` routes. Middleware rewrites `body.session` / `body.siteId`, enforces the op allow-list by inspecting the request payload, and applies the rate limit. Business logic becomes demo-unaware. `DEMO_MODE=0` (default) → middleware is a no-op, zero overhead.

**Why deferred:** Not a correctness issue — demo mode works today and the tests cover it. This is a modularity cleanup. Safe to ship OSS without doing it; just a minor code-smell for the first wave of contributors who read `demo-mode.ts`.

**Trigger:** After the first external contributor asks why demo-mode checks are inside `applyOpsAtomically`. Or after 1 month post-launch. Whichever comes first.

**Effort:** ~1–2 days. Touches `demo-mode.ts`, `ops-engine.ts`, chat pipeline, and `demo-mode.test.ts`. Tests should not need to change substantively — the middleware sees the same payloads.

### 4. Deployment & troubleshooting docs in README / CONTRIBUTING

**Status:** deferred. **Context:** OSS-readiness review, 2026-04-18.

Main `README.md` does not mention deployment. `docs/operations/` has per-platform guides (Docker, Vercel, Netlify, Render) but they are not linked from the top-level entry point. `CONTRIBUTING.md` covers dev setup but not common issues (port conflicts, Node version mismatches, `.next` cache problems, Next.js workspace-package caching — see `feedback_nextjs_cache.md`).

**Target shape:**
- Add "Deployment" section to README with one-line summary + link to each `docs/operations/*.md` guide.
- Add "Troubleshooting" section to CONTRIBUTING.md with top 5–10 issues and fixes. Start from memory entries: `feedback_nextjs_cache.md`, `turbopack_dev_blocked.md`, `feedback_dev_server.md`, `feedback_package_entrypoints.md`.
- Consider a `docs/operations/platform-notes.md` explaining Render-specific code (`x-forwarded-for` parsing in `apps/orchestrator/src/index.ts`) and graceful fallback on other platforms.

**Why deferred:** Documentation gaps don't block the first contributor PR, but they compound — every "hey my dev server won't start" issue in GitHub Issues is one we could have prevented.

**Trigger:** Within the first 2 weeks after launch. Any recurring GitHub Issue about setup/deploy is a signal to prioritize.

**Effort:** ~1 day.

---

## Done pre-launch (for reference)

### PublishTarget plugin interface

Implemented 2026-04-18. `apps/orchestrator/src/publish/publish-target.ts` defines the interface + context + outcome types. `publish/targets/` holds the three built-in targets (`site-contract`, `git`, `deploy-hook`). Route `/publish` dispatches through `selectPublishTarget(ctx)` from `publish/publish-target-registry.ts`.

Third parties can now register custom publish targets (S3, GitLab Pages, custom CI, etc.) without forking the orchestrator. See `publish-target-registry.ts` for the `registerPublishTarget()` API.
