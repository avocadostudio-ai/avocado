# Things To Improve

This document tracks high-impact product and architecture improvements for the AI site editor.

## Current priorities

1. ~~Split `apps/orchestrator/src/index.ts` into domain modules~~ — **Done.** Domain logic extracted to `src/chat/`, `src/nlp/`, `src/ops/`, `src/telemetry/`, `src/state/`, `src/publish/`; route handlers extracted to `src/routes/*.ts`; `index.ts` is now a thin bootstrap (~130 lines).
2. Add a typed contract layer between NLP parsing and apply.
3. Build a golden prompt regression suite from real telemetry.
4. Add property-based tests for normalization/repair.
5. Add deterministic, stable failure codes for every non-applied outcome.
6. Add a trace-level debug bundle endpoint for rapid issue reproduction.
7. ~~Extract editor chat state into focused UI/domain modules~~ — **Done.** `apps/editor/src/App.tsx` split into `chat-state.ts`, `editor-actions.ts`, `editor-layout.tsx`, `chat-panel.tsx`.
8. Expand automated e2e coverage for critical user flows.
9. Add deterministic field-source binding (`ai.bind`-style) for sensitive outputs (hero image URL, CTA links, product pricing, legal copy snippets) so those fields can only be populated from approved tools or explicit constants.
10. Add first-class request middleware (`prepareRequest`-style) in orchestrator AI clients to inject auth, tenant headers, policy tags, redaction, and audit metadata before every provider call.
11. Add a dedicated deterministic agent SSE integration suite for `/agent/start`, `/agent/stream`, and `/agent/cancel` (separate from live LLM edit e2e), including replay (`afterSeq`), cancel behavior, auth/validation errors, and final event contract assertions.

## Why these matter

- The current orchestrator file has concentrated critical logic and high change velocity, increasing regression risk.
- Manual UI testing is effective, but we need tighter loops from failure -> test -> fix.
- Telemetry now exists; we should leverage it to prioritize and validate improvements.

## Execution plan for #1 (complete)

Extracted modules:

- `src/chat/chat-pipeline.ts` — chat pipeline orchestration
- `src/chat/variation-pipeline.ts` — variation generation
- `src/chat/planner.ts` — OpenAI planner integration
- `src/nlp/plan-normalizer.ts` — plan normalization/repair
- `src/nlp/intent-detection.ts` — intent classification
- `src/nlp/intent-helpers.ts` — NLP utilities
- `src/nlp/deterministic-planner.ts` — demo/deterministic planner
- `src/ops/ops-engine.ts` — operation application engine
- `src/telemetry/chat-telemetry.ts` — telemetry store
- `src/state/session-state.ts` — session state management
- `src/publish/publish-helpers.ts` — publish/restore logic
- `src/routes/content.ts` — content read routes
- `src/routes/publishing.ts` — publish/restore routes
- `src/routes/chat.ts` — chat + variations + stream routes
- `src/routes/ops.ts` — ops route
- `src/routes/media.ts` — audio transcribe + image interpret routes
- `src/routes/history.ts` — undo/redo routes
- `src/routes/route-context.ts` — shared route context type

## Execution plan for #11

- Add a test seam in `apps/orchestrator/src/routes/agent.ts` so tests can inject a deterministic `runAgentLoop` implementation.
- Create `apps/orchestrator/src/agent-stream-integration.test.ts` using `app.inject` to validate start/stream/cancel contracts without provider API calls.
- Cover `POST /agent/start` validation (`x-agent-api-key`, key format, required `message`, required `siteId`).
- Cover SSE sequence behavior for `/agent/stream`: buffered replay with `afterSeq`, ordered `_seq` progression, and terminal `final` or `error`.
- Cover `/agent/cancel` while active and assert stream closure plus terminal error payload.
- Add a dedicated script (`test:integration:agent`) and document the split: deterministic stream contract tests vs live `test:e2e:agent` behavior tests.
