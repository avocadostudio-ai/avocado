# Observability as Correctness: End-to-End Correlation Plan

Date: 2026-03-03

## Why this change

The current telemetry is useful but event-centric. We can debug failures, but we do not yet have a full lifecycle trace for each chat/edit request.

AI editing failures are often non-obvious:

- schema rejects
- partial apply failures
- repair/retry loops
- model behavior drift
- preview sync mismatches

Treating observability as part of correctness means every request should be inspectable as one correlated execution, not separate logs.

## Current state in repo

### Already implemented

- Structured chat telemetry phases in orchestrator:
  - `received`
  - `forced_plan`
  - `deterministic_plan_generated`
  - `plan_attempt_failed`
  - `plan_generated`
  - `plan_apply_failed`
  - `repair_attempt`
  - `repair_generated`
  - `result`
- NDJSON persistence + API endpoints:
  - `GET /telemetry/chat`
  - `GET /telemetry/chat/review`
- Per-request `traceId` already included in chat debug payloads.
- Preview patch transport includes `txId` + `patchAck` handshake.

### Gaps

- No parent/child span model (flat events only).
- No standardized duration per lifecycle stage.
- No shared trace context across orchestrator + editor + preview bridge.
- Preview patch ack latency is not linked to server request trace.
- No first-class rollback span when progressive apply fails.

## Target model

Every chat/edit request is one root trace: `chat.request`.

Child spans:

1. `intent.detect`
2. `plan.generate` (attempt-aware)
3. `plan.normalize`
4. `repair.attempt`
5. `repair.generate`
6. `plan.validate`
7. `ops.apply`
8. `ops.rollback` (when needed)
9. `preview.sync` (patch ack timing)
10. `response.finalize`

Correlated by shared identifiers:

- `traceId`
- `spanId`
- `parentSpanId`
- `session`
- `siteId`
- `requestedSlug`
- `effectiveSlug`
- `provider`
- `modelKey`
- `modelUsed`
- `promptHash`

## Proposed implementation

### Phase 1: Span model on top of existing telemetry

Goal: no behavior change, just richer telemetry.

- Add telemetry tracing helper in orchestrator (example: `src/telemetry/trace.ts`):
  - `startChatTrace(...)`
  - `startSpan(name, attrs)`
  - `endSpan(status, attrs?)`
  - `recordException(error, attrs?)`
- Extend telemetry entry shape with optional:
  - `traceId`
  - `spanId`
  - `parentSpanId`
  - `durationMs`
  - `attempt`
- Keep existing phase events for backward compatibility.
- In `runChatPipeline(...)`, wrap each existing stage with span boundaries.

### Phase 2: OpenTelemetry exporter and resource context

Goal: interoperable telemetry backend support.

- Add dependencies in orchestrator:
  - `@opentelemetry/api`
  - `@opentelemetry/sdk-node`
  - `@opentelemetry/exporter-trace-otlp-http`
  - `@opentelemetry/resources`
- Configure resource attributes:
  - `service.name=ai-site-editor-orchestrator`
  - `service.version=<git sha or package version>`
  - `deployment.environment=<env>`
- Enable with env switch:
  - `OTEL_ENABLED=1`
  - `OTEL_EXPORTER_OTLP_ENDPOINT=...`

### Phase 3: Cross-app correlation to preview ack

Goal: close the loop from plan/apply to user-visible preview sync.

- Include `traceId` + operation index in `op_applied` SSE payload.
- In editor `usePreviewBridge`, measure:
  - patch send timestamp
  - patch ack timestamp
  - `ackMs`
- Add endpoint `POST /telemetry/preview-ack` in orchestrator to ingest:
  - `traceId`
  - `txId`
  - `opIndex`
  - `ackMs`
  - `accepted`
  - `reason`
- Emit `preview.sync` child span from this payload.

### Phase 4: Correctness-oriented metrics and SLOs

Metrics:

- Histograms:
  - `chat.plan.duration_ms`
  - `chat.apply.duration_ms`
  - `chat.preview_ack.duration_ms`
- Counters:
  - `chat.retry.count`
  - `chat.repair.count`
  - `chat.rollback.count`
  - `chat.schema_reject.count`
  - `chat.partial_apply.count`

Initial thresholds to monitor:

- p95 `plan.generate` latency
- p95 `preview.sync` ack latency
- repair rate
- rollback rate
- schema rejection rate

## Suggested code touchpoints

- `apps/orchestrator/src/chat/chat-pipeline.ts`
  - root trace and child spans around each lifecycle stage
- `apps/orchestrator/src/telemetry/chat-telemetry.ts`
  - entry schema enrichment for span metadata and durations
- `apps/orchestrator/src/routes/chat.ts`
  - include trace context in SSE op events
- `apps/editor/src/hooks/useChatEngine.ts`
  - carry trace context through streaming apply path
- `apps/editor/src/hooks/usePreviewBridge.ts`
  - measure and report patch ack timing
- `packages/preview-adapter/src/preview-bridge.tsx`
  - keep ack semantics stable; optional payload enrichment

## Rollout strategy

1. Ship Phase 1 behind `CHAT_TRACE_SPANS=1` and keep existing telemetry output unchanged.
2. Validate in local + integration tests (`chat-pipeline-integration.test.ts`).
3. Enable Phase 2 in staging only; verify trace volume and cardinality.
4. Add Phase 3 preview ack ingestion; ensure no UI regression when endpoint unavailable.
5. Start alerting on correctness metrics (repair/rollback/schema reject trends).

## Risks and mitigations

- Risk: telemetry cardinality explosion.
  - Mitigation: cap high-cardinality attributes; hash long text; avoid raw prompts.
- Risk: frontend reporting failures.
  - Mitigation: fire-and-forget preview ack endpoint; never block user flow.
- Risk: migration breaks existing telemetry consumers.
  - Mitigation: additive schema only; keep old fields/phases.

## Definition of done

- Every chat/edit request has one root trace with child spans for planning, validation, apply, and preview sync.
- Failed edits are searchable by `traceId` with clear stage failure location.
- Repair/retry/rollback rates are measurable over time.
- Preview ack latency is visible and attributable to specific edit traces.
