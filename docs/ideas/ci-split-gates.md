# CI Split Gates (Deferred)

## Context

`.github/workflows/planner-eval.yml.disabled` exists but is not active. There is no automated test gate on PRs or on merges to `main`. Before going OSS, distributed contributors can submit PRs that regress the chat pipeline, planner, or ops engine without anyone noticing until a manual `pnpm test:unit` run. Re-enabling CI is a pre-launch must-have, but not a day-one blocker — it can land as part of the OSS launch push.

The naive approach — "turn the workflow back on" — runs into one real problem: the full test suite includes e2e planner tests that require API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`). Forked PRs can't access repo secrets. So the real design question is how to split the gate so that fork PRs get *some* gate, and trusted-branch runs get the full gate.

---

## Design

Two workflows, two trigger scopes.

### 1. `test-pr.yml` — runs on every PR, including forks

Triggers: `pull_request` from any source.

Runs without secrets:
- `pnpm typecheck`
- `pnpm test:unit` (orchestrator + blocks pure-function tests, ~2s wall time)
- `pnpm --filter @ai-site-editor/orchestrator test:integration` (Fastify `inject` tests, no outbound LLM calls)

Skip e2e tests here — they need API keys, and fork PRs can't be trusted with them anyway.

Goal: fast feedback (< 3 min), catches the majority of regressions, safe for fork PRs.

### 2. `test-main.yml` — runs on push to `main` after merge

Triggers: `push` to `main`.

Runs with secrets (injected via `secrets.OPENAI_API_KEY`, etc.):
- Everything from `test-pr.yml`
- `pnpm test:e2e` — LLM-dependent planner tests (~30s+)
- Planner eval suite (from the currently-disabled workflow)

Goal: catch planner quality regressions after merge. Failure should alert (Slack, email) but not auto-revert.

### 3. Optional — `test-trusted-pr.yml`

Triggers: `pull_request_target` with `if: github.event.pull_request.head.repo.full_name == github.repository`.

Runs everything including e2e, but ONLY when the PR is from a branch in the main repo (not a fork). Gives maintainers full coverage on their own PRs without exposing secrets to forks.

---

## What to decide before landing

- Which secrets to provision in the repo (decide which LLM providers the e2e suite hits by default).
- Whether planner-eval runs on every main push or on a nightly cron (it's expensive; nightly is probably enough).
- Alerting destination for `main` failures — GitHub issue? Slack webhook?

## Effort

~1 day. The existing `.yml.disabled` file already has the planner-eval structure; the work is splitting it in two and writing the secrets-free unit/integration variant.

## Trigger to do this

Before the first public launch push (HN / Twitter / Product Hunt). Can slip a few days after the launch if needed, but not more — the first wave of contributor PRs is the exact scenario this guards against.
