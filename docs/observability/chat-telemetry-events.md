# Chat Telemetry Events

This document is the source-of-truth reference for telemetry events emitted by the orchestrator chat pipeline.

## Scope

This covers events pushed via `ctx.chatTelemetry.push(...)` in:

- `apps/orchestrator/src/chat/chat-pipeline.ts`

And serialized/logged by:

- `apps/orchestrator/src/telemetry/chat-telemetry.ts`

It does **not** cover generic operational logs such as `chat_pipeline_start` or image rewrite logs.

## Event Transport

Each telemetry entry is:

1. Buffered in memory.
2. Optionally persisted as NDJSON.
3. Emitted to server logs as a structured log with `event: "chat_telemetry"`.

Default persisted file path (unless overridden):

- `CHAT_TELEMETRY_FILE` or `../../.data/chat-telemetry.ndjson`

## Event Schema

Fields from `ChatTelemetryEntry`:

- Required: `id`, `at`, `phase`, `session`, `requestedSlug`, `effectiveSlug`, `plannerSource`, `modelKey`, `modelUsed`, `promptHash`, `promptExcerpt`, `promptLength`
- Optional classification: `outcome`, `reason`, `reasonCategory`
- Optional plan shape: `intent`, `opCount`, `opTypes`
- Optional usage/cost: `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `estimatedUsd`
- Optional timing: `totalDurationMs`, `planningDurationMs`, `firstPlanningTokenMs`, `applyDurationMs`, `imageResolutionDurationMs`, `planningAttempts`

`reasonCategory` values are from guardrail classification:

- `schema_violation`
- `ambiguity`
- `not_found`
- `no_effective_change`
- `internal_error`

## Phases

`phase` is one of:

1. `received`
2. `forced_plan`
3. `deterministic_plan_generated`
4. `plan_attempt_failed`
5. `plan_generated`
6. `plan_apply_failed`
7. `repair_attempt`
8. `repair_generated`
9. `result`

## Outcomes

### Emitted telemetry outcomes (`chatTelemetry.push`)

1. `guardrail_failure`
2. `needs_clarification`
3. `plan_ready_for_approval`
4. `no_effective_change`
5. `applied`
6. `apply_failed`
7. `apply_pending_plan_error`
8. `forced_duplicate_page`
9. `forced_create_page`
10. `planner_exception`
11. `deterministic_plan_ready`
12. `attempt_${attempt}_failed` (dynamic, e.g. `attempt_1_failed`)
13. `planning_exhausted`
14. `planning_missing`
15. `repair_started`
16. `repair_plan_generated`
17. `repair_failed`

### Debug-only outcomes (response payload, not telemetry rows)

1. `validation_error`
2. `pending_plan_missing`
3. `pending_plan_mismatch`
4. `info`
5. `advice`

## Phase to Outcome Mapping

Common mappings in current implementation:

- `received`: no `outcome`
- `forced_plan`: `forced_duplicate_page`, `forced_create_page`
- `deterministic_plan_generated`: `deterministic_plan_ready`
- `plan_attempt_failed`: `attempt_${attempt}_failed`
- `plan_generated`: usually no `outcome` (plan metadata + optional usage)
- `plan_apply_failed`: `apply_failed`
- `repair_attempt`: `repair_started`
- `repair_generated`: `repair_plan_generated`
- `result`: terminal or branch outcomes such as `applied`, `needs_clarification`, `planning_exhausted`, `repair_failed`, etc.

## Telemetry APIs

List entries:

- `GET /telemetry/chat?limit=<n>&outcome=<outcome>&phase=<phase>&session=<session>`

Review aggregate:

- `GET /telemetry/chat/review?limit=<n>&session=<session>`

`/telemetry/chat/review` currently treats these as failure outcomes:

- `guardrail_failure`
- `apply_failed`
- `repair_failed`
- `planner_exception`
- `planning_exhausted`
- `planning_missing`

## Cache Metrics

Cache-related fields:

- `cacheReadInputTokens`
- `cacheCreationInputTokens`

Provider mapping:

- OpenAI: `cacheReadInputTokens` maps to `cached_tokens` (from usage details)
- Anthropic: `cacheReadInputTokens` maps to `cache_read_input_tokens`; `cacheCreationInputTokens` maps to `cache_creation_input_tokens`

## Source References

- `apps/orchestrator/src/telemetry/chat-telemetry.ts`
- `apps/orchestrator/src/chat/chat-pipeline.ts`
- `apps/orchestrator/src/index.ts` (telemetry endpoints)
