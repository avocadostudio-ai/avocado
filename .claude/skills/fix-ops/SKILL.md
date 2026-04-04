---
name: fix-ops
description: Diagnose and fix operation execution issues from debug trace logs. Use when ops produce wrong opCount, missing blocks, skipped ops, or unexpected outcomes.
---

# Fix Ops Execution

## Input: Debug Trace Format

The user provides a log like:

```
Added Hero.

Debug
traceId: <uuid>
promptHash: <hash>
outcome: applied
reason: malformed_output
reasonDetail: LLM did not return valid JSON (first 300 chars of error)
intent: edit_plan
plannerTier: full_llm
model: gpt-4o (openai)
planningAttempts: 2
opCount: 1
skippedOps: [0] update_props /about#b_hero: unchanged_value
ops: add_block
tokens: in:1234 out:567 total:1801
cost: $0.0023
timeline: request_received:0ms -> first_structured_progress:2ms -> plan_ready:2ms -> first_op_applied:4ms -> done:4ms
prompt: add 3 blocks: hero, cardgrid and CTA [site context] Site purpose: ...
```

Not all fields are always present — optional fields appear only when relevant (e.g. `reasonDetail` only on failures, `planningAttempts` only when >1, `tokens`/`cost` only for LLM plans).

## Ops Engine Internals

For detailed reference on atomicity, all 15 op signatures, key behaviors (fuzzy matching, deep merge, skipped ops, progressive apply), error classification, repair flow, plan normalization, and image resolution, see [ops-engine-internals.md](ops-engine-internals.md).

## Diagnosis Workflow

### Step 1: Parse the trace

Extract these fields from the debug log:

| Field | What it tells you |
|-------|------------------|
| `outcome` | `applied` = ops ran; `apply_failed` = ops threw; `planning_exhausted` = LLM failed; `repair_failed` = auto-repair also failed; `needs_clarification` = planner refused/returned clarification; `planning_missing` = planner returned null; `no_effective_change` = all ops skipped; `planner_exception` = LLM client threw |
| `reason` | Error category (e.g. `malformed_output`, `schema_violation`) |
| `reasonDetail` | Raw error string (first 300 chars) — gives the exact error for pattern-matching without reading source |
| `plannerTier` | `deterministic` = code bug in deterministic planner; `llm_intent_router` = fast router issue; `full_llm` = prompt/model issue; `demo` = demo mode |
| `model` | Actual model name + source (e.g. `gpt-4o (openai)`) — identifies model-specific failures |
| `planningAttempts` | >1 means retries happened — useful for understanding latency and retry exhaustion |
| `opCount` | Number of ops the planner generated |
| `ops` | Comma-separated op types that were generated |
| `skippedOps` | Detailed skip info: `[index] op_type slug#blockId: reason` — pinpoints which ops were no-ops |
| `tokens` | `in:X out:Y total:Z` — identifies context window pressure |
| `cost` | Estimated USD — flags unexpectedly expensive calls |
| `timeline` | Where time was spent; if `plan_ready` is <10ms it was deterministic, not LLM |
| `prompt` | The actual message sent to the planner (after sanitization) |

### Step 2: Identify the bug class

**Compare `prompt` vs `opCount` to determine what went wrong:**

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| `opCount` < expected, timeline shows deterministic (plan_ready <10ms) | Deterministic planner generated too few ops | `deterministic-planner.ts` — `compileDeterministicPlan()` and `inferDeterministicIntent()` |
| `opCount` < expected, timeline shows LLM (plan_ready >500ms) | LLM returned incomplete plan; strict-primary-op mode may be active | `planner.ts` or `anthropic-planner.ts` — check `isChatStrictPrimaryOpMode()` and batch override (`isBatchAddRequest`, `isBatchRemoveRequest`, `isBatchReorderRequest`, `isPageWideRewriteRequest`) |
| `opCount: 1`, `outcome: applied`, user expected many ops | Strict-primary-op mode truncated a multi-op plan because no batch detector matched | `intent-detection.ts` — add a new `isBatch*Request()` for the unrecognized pattern, wire into `batchOverride` in both planners |
| `opCount` correct but `outcome: apply_failed` | Ops engine rejected an operation (duplicate ID, invalid props, missing ref) | `ops-engine.ts` — `applyOpsAtomically()` |
| `opCount` correct but some ops show `op_skipped` | Empty patch or unchanged value — see SkippedOps behavior above |
| `ops` shows wrong type (e.g. `update_props` instead of `add_block`) | Intent detection or plan normalization mapped incorrectly | `intent-detection.ts`, `plan-normalizer.ts` |
| Timeline shows `first_token` but no `plan_ready` | LLM stream parsing failed | `planner.ts` — `extractOpsFromPlanBuffer()` |
| `outcome: repair_failed` | Initial plan had `schema_violation`, auto-repair also failed | Check repair feedback, schema contracts, `forceFullSchemaContracts` path |
| `outcome: needs_clarification` | Planner refused or returned clarification instead of ops | Check if user prompt is ambiguous; planner refusal handling |
| `outcome: no_effective_change` | All ops skipped — patch values identical to current props | Verify props actually differ from current state |
| `outcome: planner_exception` | Demo planner or LLM client threw | `planner.ts` error handling, API key config |
| `continue_chain` execution mode in trace | Multi-step decomposer processing step N | `decomposer.ts` — `isMultiStepCandidate()`, `decomposeRequest()` |

### Step 3: Run targeted tests BEFORE fixing

Run ONLY the tests relevant to the bug class. See [test-patterns.md](test-patterns.md) for the full lookup table of bug class → test command, test file locations, and example test patterns.

### Step 4: Write a failing test that reproduces the bug

Add a test in the appropriate test file that encodes the user's exact scenario. Use the `prompt` from the debug trace as input. See [test-patterns.md](test-patterns.md) for test file locations and example patterns using existing helpers.

**Run the new test to confirm it fails:**

```bash
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "<new test name>"
```

### Step 5: Fix the code

Apply the minimal fix based on diagnosis from Step 2. Common fixes:

**Deterministic planner not generating enough ops:**
- Check `inferDeterministicIntent()` — does it return the right action for batch requests?
- Check `compileDeterministicPlan()` — does it iterate over all mentioned block types?
- Check `isBatchAddRequest()` — does the regex match the user's phrasing?

**LLM planner returning too few ops:**
- Check `isChatStrictPrimaryOpMode()` — is strict mode blocking multi-op plans?
- Check the batch override: `isBatchAddRequest()`, `isBatchRemoveRequest()`, `isBatchReorderRequest()`, or `isPageWideRewriteRequest()` must return `true` for the prompt to disable strict mode
- If none match, add a new `isBatch*Request()` detector in `intent-detection.ts` and add it to `batchOverride` in both `planner.ts` and `anthropic-planner.ts`
- Check system prompt construction — does it include the batch instruction lines?

**Ops engine rejecting operations:**
- Check for duplicate block IDs in the generated plan
- Check `validateBlockProps()` — are default props being populated?
- Check `defaultPropsForType()` in `plan-normalizer.ts` for the block type

### Step 6: Verify & restart

```bash
# 1. Run targeted tests to confirm the fix
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "<new test name>"

# 2. Typecheck
pnpm typecheck

# 3. Restart dev servers
/restart
```

**After restarting, notify the user:**
- Tell them what was wrong (root cause from Step 2)
- What was fixed (the code change from Step 5)
- That the server has been restarted
- Ask them to retry the same prompt to verify the fix works end-to-end in the editor

If the user asks for a full regression run, use: `pnpm --filter @ai-site-editor/orchestrator test`

Example notification:
> Fixed: The deterministic planner was only generating 1 op for batch add requests because `compileDeterministicPlan()` didn't iterate over all mentioned block types. Now generates an `add_block` op for each type mentioned.
>
> Targeted tests pass. Server restarted. Please retry "add 3 blocks: hero, cardgrid and CTA" to verify.

## Key Files Reference

| File | Purpose |
|------|---------|
| `apps/orchestrator/src/nlp/intent-detection.ts` | `isBatchAddRequest()`, `isBatchRemoveRequest()`, `isBatchReorderRequest()`, `isPageWideRewriteRequest()`, `countMentionedBlockTypes()`, batch detection patterns |
| `apps/orchestrator/src/nlp/deterministic-planner.ts` | `inferDeterministicIntent()`, `compileDeterministicPlan()`, `defaultPropsForType()` |
| `apps/orchestrator/src/nlp/plan-normalizer.ts` | `normalizePlanCandidate()`, `inferBlockTypeFromText()`, op name aliases |
| `apps/orchestrator/src/ops/ops-engine.ts` | `applyOpsAtomically()`, validation, error classification |
| `apps/orchestrator/src/chat/planner.ts` | `generatePlanWithOpenAI()`, `isChatStrictPrimaryOpMode()`, `extractOpsFromPlanBuffer()` |
| `apps/orchestrator/src/chat/anthropic-planner.ts` | `generatePlanWithAnthropic()`, Anthropic tool-use streaming |
| `apps/orchestrator/src/chat/chat-pipeline.ts` | `runChatPipeline()`, `respondFromPlan()`, progressive apply loop, repair flow |
| `apps/orchestrator/src/chat/decomposer.ts` | `isMultiStepCandidate()`, `decomposeRequest()`, multi-step chain handling |
| `apps/orchestrator/src/nlp-ops.test.ts` | Tests for intent detection, deterministic planner, plan normalization |
| `apps/orchestrator/src/ops/ops-engine.test.ts` | Tests for operation execution |
| `apps/orchestrator/src/apply-ops.test.ts` | Tests for HTTP /ops endpoint (all op types via Fastify) |
| `apps/orchestrator/src/planner-openai.test.ts` | Tests for OpenAI planner contract |
| `apps/orchestrator/src/chat-pipeline-integration.test.ts` | End-to-end pipeline tests with mocked planners |
| `apps/orchestrator/src/chat/translation-coverage.test.ts` | Translation coverage gap detection tests |

## Common Pitfalls

See [test-patterns.md](test-patterns.md) for the full list of common pitfalls including: deterministic vs LLM path detection, strict primary-op mode, block type inference, default props, image placeholders, normalization surprises, test runner gotchas, and batch override coverage gaps.
