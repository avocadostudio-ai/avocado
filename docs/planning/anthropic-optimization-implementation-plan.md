# Anthropic-Only Optimization Implementation Plan

Date: 2026-03-04  
Status: Planned (not implemented)

## Scope

This plan intentionally excludes OpenAI optimization work for now.

- Optimize only Anthropic chat planning + Anthropic intent routing paths.
- Keep deterministic planner path in scope.
- Defer OpenAI prompt/contract/context optimization until a later phase.

Primary code paths:

- `apps/orchestrator/src/chat/chat-pipeline.ts`
- `apps/orchestrator/src/chat/anthropic-planner.ts`
- `apps/orchestrator/src/chat/anthropic-cache.ts`
- `apps/orchestrator/src/telemetry/chat-telemetry.ts`
- `apps/orchestrator/src/telemetry/usage.ts`

## Goals

1. Reduce Anthropic cost per successful edit by 60-85%.
2. Reduce Anthropic p95 latency for planning-heavy requests.
3. Preserve quality and safety (no meaningful regression in applied success rate).

## Baseline Before Changes

Capture a baseline window before rollout using telemetry:

- `inputTokens`, `outputTokens`, `totalTokens`
- `cacheReadInputTokens`, `cacheCreationInputTokens`
- `estimatedUsd`
- `plannerTier`
- `contextPackBytes`
- outcomes: `applied`, `needs_clarification`, `guardrail_failure`, `repair_failed`, `planning_exhausted`
- timing: `planningDurationMs`, `totalDurationMs`, `p95 totalDurationMs`

Segment results by intent class where possible:

- content edit
- style edit
- layout change
- page/global changes

## Rollout Phases

## Phase 0: Measurement and safety gates

Purpose: establish comparison data and rollout gates.

Tasks:

1. Add/report dashboards or scripts over chat telemetry NDJSON focused on Anthropic sessions only.
2. Define go/no-go thresholds (see Acceptance Gates).
3. Confirm telemetry includes all required cache/context/timing fields.

## Phase 1: Prompt caching hardening

Purpose: maximize cache hit rate and reduce repeated prefix cost.

Tasks:

1. Keep cacheable prefix stable in Anthropic planner prompts (reduce accidental drift).
2. Introduce explicit prompt prefix versioning (`prefixVersion`) for controlled cache invalidation.
3. Add telemetry fields for cache mode inference (off/write/read/mixed) and prefix version.
4. Validate behavior with `ANTHROPIC_PROMPT_CACHE` enabled and disabled.

Notes:

- Existing prompt cache helpers already exist in `anthropic-cache.ts`.
- The main risk is prefix churn from minor template changes.

## Phase 2: Context tiering with escalation

Purpose: reduce dynamic context size while preserving quality.

Tasks:

1. Formalize context tiers:
   - `minimal`: selected block + neighbors + small route context
   - `compact`: current compact page outline strategy
   - `full`: full planner context pack
2. Start from smaller tier for focused edits.
3. Escalate tier on guardrail/validation ambiguity or target resolution failures.
4. Keep translation/page-wide and major page-structure intents on `full`.

Policy:

- Default focused edits: `minimal`.
- If plan/apply fails for context reasons: retry with `compact`.
- If still uncertain: retry with `full` or return clarification.

## Phase 3: Compact contracts/schema for planner prompt

Purpose: reduce schema/context payload without dropping required constraints.

Tasks:

1. Add compact contract representation for Anthropic planner prompts.
2. Preserve required semantics:
   - operation names
   - required fields
   - types/enums/ranges
   - forbidden/unsafe mutation constraints
3. Use compact contracts by default; include fuller contract only for create/SEO/page-structural requests.

Risk:

- Over-stripping can increase invalid plans and retries.

## Phase 4: Deterministic bypass expansion

Purpose: reduce full LLM planning calls safely.

Tasks:

1. Expand deterministic handling for high-confidence, low-ambiguity request classes.
2. Add confidence gating and clear fallback to Anthropic planner.
3. Track deterministic success and fallback rates separately.

Examples in scope:

- selected-text rewrite/rephrase
- explicit target prop edits
- simple add/remove/move with explicit anchors

## Feature Flags

Existing flags used in this rollout:

- `ANTHROPIC_PROMPT_CACHE`
- `CHAT_COMPACT_CONTEXT_EXPERIMENT`
- `CHAT_MINIMAL_CONTEXT_EXPERIMENT`
- `CHAT_LLM_INTENT_ROUTER`

New flags to add:

- `CHAT_CONTEXT_TIER_ESCALATION`
- `CHAT_COMPACT_CONTRACTS`
- `CHAT_DETERMINISTIC_EXPANSION`
- `CHAT_FORCE_PROVIDER=anthropic` (or equivalent provider guard for experiment cohorts)

## Telemetry Additions

Additions recommended for clearer attribution:

- `providerForced` (boolean)
- `providerEffective` (expected `anthropic` in scoped rollout)
- `prefixVersion` (string)
- `cacheMode` (`off|write|read|mixed`)
- `contextTier` (`minimal|compact|full`)
- `contextEscalationCount` (number)

## Acceptance Gates (Anthropic-only)

Ship criteria:

1. Input tokens/request reduced by at least 50%.
2. Applied success rate regression no worse than 2%.
3. Combined `guardrail_failure + repair_failed` increase no worse than 1.5%.
4. p95 total duration improved by at least 20%.

Rollback criteria:

- Any sustained quality regression beyond gates.
- Unexpected rise in clarification loops for straightforward edits.
- Significant increase in planning retries without cost/latency win.

## Suggested Rollout Sequence

1. Internal sessions only.
2. 10% traffic cohort (Anthropic sessions).
3. 50% cohort.
4. 100% after 48h stable metrics.

At each stage:

- compare against baseline
- check acceptance gates
- inspect top failed prompt families before increasing traffic

## Test Plan (when implementing)

Target test files:

- `apps/orchestrator/src/chat/anthropic-cache.test.ts`
- `apps/orchestrator/src/chat-pipeline-integration.test.ts`
- `apps/orchestrator/src/telemetry/usage.test.ts`

Add/extend tests for:

1. Prompt cache enable/disable and TTL behavior.
2. Context tier selection and escalation behavior.
3. Compact contract mode preserving valid operation outputs.
4. Deterministic expansion with confidence fallback.
5. Telemetry emission for new fields.

## Out of Scope (for this document)

- OpenAI prompt caching/context optimization.
- Provider-agnostic abstraction refactors not required for Anthropic rollout.
- UI changes unrelated to cost/latency optimization.

