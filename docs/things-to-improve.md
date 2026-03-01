# Things To Improve

This document tracks high-impact product and architecture improvements for the AI site editor.

## Current priorities

1. Split `apps/orchestrator/src/index.ts` into domain modules (highest ROI).
2. Add a typed contract layer between NLP parsing and apply.
3. Build a golden prompt regression suite from real telemetry.
4. Add property-based tests for normalization/repair.
5. Add deterministic, stable failure codes for every non-applied outcome.
6. Add a trace-level debug bundle endpoint for rapid issue reproduction.
7. Extract editor chat state into focused UI/domain modules.
8. Expand automated e2e coverage for critical user flows.

## Why these matter

- The current orchestrator file has concentrated critical logic and high change velocity, increasing regression risk.
- Manual UI testing is effective, but we need tighter loops from failure -> test -> fix.
- Telemetry now exists; we should leverage it to prioritize and validate improvements.

## Execution plan for #1 (in progress)

Target modules:

- `src/chat/chat-pipeline.ts`
- `src/nlp/plan-normalizer.ts`
- `src/ops/ops-engine.ts`
- `src/telemetry/chat-telemetry.ts`
- `src/routes/*.ts`

Guardrails:

- Keep behavior identical while moving code.
- Preserve API contracts and response schema.
- Validate after every extraction with typecheck + test + smoke checks.

First extraction scope:

- Move chat telemetry logic out of `index.ts` into `src/telemetry/chat-telemetry.ts`.

