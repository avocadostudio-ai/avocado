# BigQuery Analytics Integration

## Context

The orchestrator captures rich per-request chat telemetry (tokens, latency, outcomes, model info) via `ChatTelemetryStore` — but it's local NDJSON with a 500-entry circular buffer. There's no durable, queryable analytics store for understanding usage patterns, cost trends, failure rates, or publishing behavior across sessions and time. BigQuery gives us cheap append-only storage with powerful ad-hoc SQL, no infra to manage, and easy dashboard connectivity.

## Event Types & Table Schemas

### Dataset: `site_editor_analytics` (configurable via `BIGQUERY_DATASET`)

### Table 1: `chat_messages`

| Column | Type | Mode | Description |
|--------|------|------|-------------|
| event_id | STRING | REQUIRED | UUID |
| timestamp | TIMESTAMP | REQUIRED | ISO-8601 |
| session | STRING | REQUIRED | Scoped session key (includes siteId) |
| prompt_hash | STRING | REQUIRED | SHA-256 prefix (16 chars) |
| prompt_length | INTEGER | REQUIRED | Character count |
| requested_slug | STRING | NULLABLE | |
| effective_slug | STRING | NULLABLE | |
| intent | STRING | NULLABLE | Detected intent |
| planner_tier | STRING | NULLABLE | forced_deterministic / deterministic / llm_intent_router / full_llm / demo |
| planner_source | STRING | REQUIRED | openai / anthropic / demo |
| model_key | STRING | REQUIRED | fast / balanced / reasoning / codex |
| model_used | STRING | REQUIRED | Actual model name |

### Table 2: `plan_executed`

| Column | Type | Mode | Description |
|--------|------|------|-------------|
| event_id | STRING | REQUIRED | Same ID as the chat_messages entry |
| timestamp | TIMESTAMP | REQUIRED | |
| session | STRING | REQUIRED | |
| prompt_hash | STRING | REQUIRED | JOIN key to chat_messages |
| outcome | STRING | REQUIRED | applied / guardrail_failure / apply_failed / repair_failed / etc |
| reason | STRING | NULLABLE | Failure reason |
| reason_category | STRING | NULLABLE | schema_violation / not_found / ambiguity / etc |
| op_count | INTEGER | NULLABLE | |
| op_types | STRING | NULLABLE | JSON array of op type strings |
| input_tokens | INTEGER | NULLABLE | |
| output_tokens | INTEGER | NULLABLE | |
| total_tokens | INTEGER | NULLABLE | |
| cache_creation_tokens | INTEGER | NULLABLE | |
| cache_read_tokens | INTEGER | NULLABLE | |
| estimated_usd | FLOAT | NULLABLE | |
| total_duration_ms | INTEGER | NULLABLE | |
| planning_duration_ms | INTEGER | NULLABLE | |
| first_token_ms | INTEGER | NULLABLE | |
| apply_duration_ms | INTEGER | NULLABLE | |
| image_resolution_ms | INTEGER | NULLABLE | |
| planning_attempts | INTEGER | NULLABLE | |
| context_pack_bytes | INTEGER | NULLABLE | |
| contract_mode | STRING | NULLABLE | minimal / targeted / full |
| contract_bytes | INTEGER | NULLABLE | |
| planner_tier | STRING | NULLABLE | |
| planner_source | STRING | REQUIRED | |
| model_key | STRING | REQUIRED | |
| model_used | STRING | REQUIRED | |
| planner_refusal | BOOLEAN | NULLABLE | |
| planner_incomplete | BOOLEAN | NULLABLE | |
| schema_retry_used | BOOLEAN | NULLABLE | |

### Table 3: `op_applied`

| Column | Type | Mode | Description |
|--------|------|------|-------------|
| event_id | STRING | REQUIRED | UUID |
| timestamp | TIMESTAMP | REQUIRED | |
| session | STRING | REQUIRED | |
| chat_request_id | STRING | NULLABLE | Links to plan_executed.event_id |
| op_index | INTEGER | REQUIRED | Position in plan (0-based) |
| op_total | INTEGER | REQUIRED | Total ops in plan |
| op_type | STRING | REQUIRED | add_block / update_props / remove_block / etc |
| page_slug | STRING | NULLABLE | |
| block_id | STRING | NULLABLE | |
| block_type | STRING | NULLABLE | For add_block: Hero, CTA, etc |
| success | BOOLEAN | REQUIRED | |
| skipped | BOOLEAN | REQUIRED | |
| skip_reason | STRING | NULLABLE | |

### Table 4: `site_published`

| Column | Type | Mode | Description |
|--------|------|------|-------------|
| event_id | STRING | REQUIRED | UUID |
| timestamp | TIMESTAMP | REQUIRED | |
| session | STRING | REQUIRED | |
| site_id | STRING | NULLABLE | |
| page_count | INTEGER | REQUIRED | |
| block_count | INTEGER | REQUIRED | |
| publish_mode | STRING | REQUIRED | git / deploy_hook |
| status | STRING | REQUIRED | triggered / failed |
| failure_reason | STRING | NULLABLE | |
| branch | STRING | NULLABLE | |
| commit_sha | STRING | NULLABLE | |
| deploy_duration_ms | INTEGER | NULLABLE | |

---

## Architecture: BigQuerySink

Non-blocking, buffer-and-flush pattern. Two new files in `apps/orchestrator/src/telemetry/`:

### `bq-schema.ts`

- Row type definitions for each table (TypeScript interfaces)
- `TABLE_SCHEMAS` map: table name -> BQ field definitions array
- `TABLE_NAMES` constant

### `bq-sink.ts`

- `BigQuerySink` class with:
  - **`emit(table, row)`** — synchronous push to per-table buffer
  - **`flush()`** — batch-insert all buffered rows, fire-and-forget with retry on transient errors
  - **`ensureTables()`** — create dataset/tables if missing (called once at startup)
  - **`shutdown()`** — clear timer, final flush
- `createBigQuerySink(opts)` factory
- If no credentials: logs info message, all methods become no-ops
- Flush timer: every 5s (configurable). Force-flush at 100 rows per table.
- `skipInvalidRows: true`, `ignoreUnknownValues: true` — never lose the whole batch over one bad row

---

## Integration Points (minimal changes)

### 1. `apps/orchestrator/src/telemetry/chat-telemetry.ts`

- Add `onPush?: (entry: ChatTelemetryEntry) => void` to `CreateChatTelemetryStoreArgs`
- Call `args.onPush?.(entry)` at end of `push()` function (1 line)

### 2. `apps/orchestrator/src/routes/route-context.ts`

- Add `bqSink?: BigQuerySink` to `RouteContext` type

### 3. `apps/orchestrator/src/index.ts`

- Import and instantiate `createBigQuerySink({ logger: app.log })`
- Call `await bqSink.ensureTables()` during startup
- Wire `onPush` callback on `chatTelemetry` creation:
  - `phase === "received"` -> emit `chat_messages` row
  - `phase === "result"` -> emit `plan_executed` row
- Add `bqSink` to RouteContext
- Register `onClose` hook -> `await bqSink.shutdown()`

### 4. `apps/orchestrator/src/routes/chat.ts`

- In `onOpApplied` callback: emit `op_applied` row (success=true)
- In `onOpSkipped` callback: emit `op_applied` row (skipped=true)

### 5. `apps/orchestrator/src/routes/publishing.ts`

- Rename `_ctx` -> `ctx`
- After each publish result path: emit `site_published` row

### 6. `apps/orchestrator/package.json`

- Add `"@google-cloud/bigquery": "^7.9.0"`

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_APPLICATION_CREDENTIALS` | No | — | Path to service account JSON |
| `BIGQUERY_PROJECT_ID` | No | — | GCP project (falls back to credentials file) |
| `BIGQUERY_DATASET` | No | `site_editor_analytics` | Dataset name |
| `BIGQUERY_FLUSH_INTERVAL_MS` | No | `5000` | Flush timer interval |
| `BIGQUERY_MAX_BUFFER_SIZE` | No | `100` | Max rows before forced flush |
| `BIGQUERY_ENABLED` | No | `1` | Set `0` to disable even with creds present |

---

## Design Decision: `siteId` on telemetry entries

`ChatTelemetryEntry` doesn't carry `siteId`. Rather than modifying 30+ push sites, the `session` column already contains the scoped key (`{siteId}::{session}`), which is splittable in SQL. `op_applied` and `site_published` do get explicit `site_id` from route context. Can add `siteId` to telemetry entries as a follow-up if needed.

---

## Verification

1. **No-credentials path**: Start orchestrator without BQ env vars -> logs "BigQuery sink disabled", all other functionality unchanged
2. **Unit tests** for `bq-sink.ts`: mock `@google-cloud/bigquery`, verify buffering, flushing, no-op when disabled, retry on transient errors
3. **Schema tests** for `bq-schema.ts`: verify field counts/types match the plan
4. **Integration**: Send a chat message via `/chat/stream`, verify `onPush` fires for both `received` and `result` phases (existing test infra)
5. **Manual BQ verification**: With real credentials, run `bq query 'SELECT * FROM site_editor_analytics.chat_messages LIMIT 5'` after a few chat interactions
