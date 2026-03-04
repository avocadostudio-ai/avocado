# Fix Ops Execution

Activate this skill when the user provides a debug trace log from the chat pipeline and wants to diagnose/fix an operation execution issue. Typical symptoms: wrong opCount, missing blocks, skipped ops, unexpected outcome.

## Input: Debug Trace Format

The user provides a log like:

```
Added Hero.

Debug
traceId: <uuid>
promptHash: <hash>
outcome: applied
intent: edit_plan
opCount: 1
ops: add_block
timeline: request_received:0ms -> first_structured_progress:2ms -> plan_ready:2ms -> first_op_applied:4ms -> done:4ms
prompt: add 3 blocks: hero, cardgrid and CTA [site context] Site purpose: ...
```

## Diagnosis Workflow

### Step 1: Parse the trace

Extract these fields from the debug log:

| Field | What it tells you |
|-------|------------------|
| `outcome` | `applied` = ops ran; `apply_failed` = ops threw; `planning_exhausted` = LLM failed |
| `opCount` | Number of ops the planner generated |
| `ops` | Comma-separated op types that were generated |
| `timeline` | Where time was spent; if `plan_ready` is <10ms it was deterministic, not LLM |
| `prompt` | The actual message sent to the planner (after sanitization) |

### Step 2: Identify the bug class

**Compare `prompt` vs `opCount` to determine what went wrong:**

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| `opCount` < expected, timeline shows deterministic (plan_ready <10ms) | Deterministic planner generated too few ops | `deterministic-planner.ts` — `compileDeterministicPlan()` and `inferDeterministicIntent()` |
| `opCount` < expected, timeline shows LLM (plan_ready >500ms) | LLM returned incomplete plan; strict-primary-op mode may be active | `planner.ts` or `anthropic-planner.ts` — check `isChatStrictPrimaryOpMode()` and batch override |
| `opCount` correct but `outcome: apply_failed` | Ops engine rejected an operation (duplicate ID, invalid props, missing ref) | `ops-engine.ts` — `applyOpsAtomically()` |
| `opCount` correct but some ops show `op_skipped` | Empty patch or unchanged value | `ops-engine.ts` lines 541-562 |
| `ops` shows wrong type (e.g. `update_props` instead of `add_block`) | Intent detection or plan normalization mapped incorrectly | `intent-detection.ts`, `plan-normalizer.ts` |
| Timeline shows `first_token` but no `plan_ready` | LLM stream parsing failed | `planner.ts` — `extractOpsFromPlanBuffer()` |

### Step 3: Read logs and run tests BEFORE fixing

**Always run the relevant tests first to establish a baseline:**

```bash
# Run ALL orchestrator tests
pnpm --filter @ai-site-editor/orchestrator test

# Run specific test files based on the bug class:
# For deterministic planner issues:
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "deterministic|batch|isBatchAdd"

# For ops engine issues:
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "applyOps|add_block|ops-engine"

# For plan normalization issues:
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "normalize|inferBlock"

# For chat pipeline integration:
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "chat"
```

**Read the relevant source files to understand current behavior:**

- Intent detection: `apps/orchestrator/src/nlp/intent-detection.ts` — `isBatchAddRequest()`, `countMentionedBlockTypes()`
- Deterministic planner: `apps/orchestrator/src/nlp/deterministic-planner.ts` — `inferDeterministicIntent()`, `compileDeterministicPlan()`
- Plan normalization: `apps/orchestrator/src/nlp/plan-normalizer.ts` — `normalizePlanCandidate()`, `normalizeOpName()`
- Ops engine: `apps/orchestrator/src/ops/ops-engine.ts` — `applyOpsAtomically()`
- OpenAI planner: `apps/orchestrator/src/chat/planner.ts` — `generatePlanWithOpenAI()`, `isChatStrictPrimaryOpMode()`
- Anthropic planner: `apps/orchestrator/src/chat/anthropic-planner.ts` — `generatePlanWithAnthropic()`
- Chat pipeline: `apps/orchestrator/src/chat/chat-pipeline.ts` — `runChatPipeline()`, `respondFromPlan()`

### Step 4: Write a failing test that reproduces the bug

Add a test in the appropriate test file that encodes the user's exact scenario. Use the `prompt` from the debug trace as input.

**Test file locations by bug class:**

| Bug class | Test file |
|-----------|-----------|
| Deterministic intent / batch detection | `apps/orchestrator/src/nlp-ops.test.ts` |
| Ops engine apply failures | `apps/orchestrator/src/ops/ops-engine.test.ts` |
| Plan normalization | `apps/orchestrator/src/nlp-ops.test.ts` |
| Full pipeline (end-to-end) | `apps/orchestrator/src/chat-pipeline-integration.test.ts` |
| OpenAI planner contract | `apps/orchestrator/src/planner-openai.test.ts` |

**Test patterns — use existing helpers:**

```typescript
// nlp-ops.test.ts — testing intent detection
test("isBatchAddRequest detects 'add 3 blocks: hero, cardgrid and CTA'", () => {
  assert.equal(isBatchAddRequest("add 3 blocks: hero, cardgrid and CTA"), true)
})

// nlp-ops.test.ts — testing deterministic plan compilation
test("compileDeterministicPlan generates 3 ops for batch add", () => {
  const intent = inferDeterministicIntent({
    message: "add 3 blocks: hero, cardgrid and CTA",
    currentPage: demoPublishedPages()[0],
    activeBlockId: undefined,
    activeEditablePath: undefined
  })
  // assert intent is as expected, then compile
  const plan = compileDeterministicPlan({ ... })
  assert.equal(plan.ops.length, 3)
})

// ops-engine.test.ts — testing ops apply
test("applyOpsAtomically handles 3 add_block ops", () => {
  seedSession()
  const result = applyOpsAtomically(TEST_SESSION, [
    { op: "add_block", pageSlug: "/", block: { id: "b_new_hero", type: "Hero", props: {...} } },
    { op: "add_block", pageSlug: "/", block: { id: "b_new_cg", type: "CardGrid", props: {...} } },
    { op: "add_block", pageSlug: "/", block: { id: "b_new_cta", type: "CTA", props: {...} } }
  ])
  assert.equal(result.appliedCount, 3)
})
```

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
- Check that `isBatchAddRequest()` returns `true` for the prompt (this disables strict mode)
- Check system prompt construction — does it include the batch instruction lines?

**Ops engine rejecting operations:**
- Check for duplicate block IDs in the generated plan
- Check `validateBlockProps()` — are default props being populated?
- Check `defaultPropsForType()` in `plan-normalizer.ts` for the block type

### Step 6: Run tests AFTER fixing

```bash
# Run the specific failing test to confirm it passes
pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "<new test name>"

# Run ALL orchestrator tests to confirm no regressions
pnpm --filter @ai-site-editor/orchestrator test

# Run typecheck across all workspaces
pnpm typecheck
```

### Step 7: Iterate if tests fail

If the fix breaks other tests or the new test still fails:
1. Read the failing test output carefully
2. Trace through the code path with the failing input
3. Adjust the fix
4. Re-run tests
5. Repeat until all tests pass

### Step 8: Restart dev server & notify user

The orchestrator uses `tsx watch` which auto-reloads on file changes. However, **always restart the dev servers after applying a fix** to guarantee the running server picks up all changes:

```bash
# Use the restart skill
/restart
```

**Restart is required when:**
- Any orchestrator source file was modified (intent detection, planner, ops engine, pipeline)
- Environment variables were changed (e.g. `CHAT_STRICT_PRIMARY_OP`, `CHAT_INCREMENTAL_APPLY`)
- State file may be corrupted from a failed apply

**After restarting, notify the user:**
- Tell them what was wrong (root cause from Step 2)
- What was fixed (the code change from Step 5)
- That the server has been restarted
- Ask them to retry the same prompt to verify the fix works end-to-end in the editor

Example notification:
> Fixed: The deterministic planner was only generating 1 op for batch add requests because `compileDeterministicPlan()` didn't iterate over all mentioned block types. Now generates an `add_block` op for each type mentioned.
>
> Tests pass. Server restarted. Please retry "add 3 blocks: hero, cardgrid and CTA" to verify.

## Key Files Reference

| File | Purpose |
|------|---------|
| `apps/orchestrator/src/nlp/intent-detection.ts` | `isBatchAddRequest()`, `countMentionedBlockTypes()`, batch add regex patterns |
| `apps/orchestrator/src/nlp/deterministic-planner.ts` | `inferDeterministicIntent()`, `compileDeterministicPlan()`, `defaultPropsForType()` |
| `apps/orchestrator/src/nlp/plan-normalizer.ts` | `normalizePlanCandidate()`, `inferBlockTypeFromText()`, op name aliases |
| `apps/orchestrator/src/ops/ops-engine.ts` | `applyOpsAtomically()`, validation, error classification |
| `apps/orchestrator/src/chat/planner.ts` | `generatePlanWithOpenAI()`, `isChatStrictPrimaryOpMode()`, `extractOpsFromPlanBuffer()` |
| `apps/orchestrator/src/chat/anthropic-planner.ts` | `generatePlanWithAnthropic()`, Anthropic tool-use streaming |
| `apps/orchestrator/src/chat/chat-pipeline.ts` | `runChatPipeline()`, `respondFromPlan()`, progressive apply loop |
| `apps/orchestrator/src/nlp-ops.test.ts` | Tests for intent detection, deterministic planner, plan normalization |
| `apps/orchestrator/src/ops/ops-engine.test.ts` | Tests for operation execution |
| `apps/orchestrator/src/chat-pipeline-integration.test.ts` | End-to-end pipeline tests with mocked planners |

## Common Pitfalls

- **Deterministic path vs LLM path**: If `plan_ready` is <10ms in the timeline, the plan came from `inferDeterministicIntent()` + `compileDeterministicPlan()`, NOT from the LLM. Fix the deterministic planner, not the prompt.
- **Strict primary-op mode**: `isChatStrictPrimaryOpMode()` limits plans to 1 operation unless `isBatchAddRequest()` returns `true`. Always verify the batch detection regex matches the user's exact phrasing.
- **Block type inference**: `inferBlockTypeFromText()` does fuzzy matching (e.g. "cardgrid" -> "CardGrid"). If a block type isn't recognized, the op may be dropped during normalization.
- **Default props**: `defaultPropsForType()` provides minimum valid props for `add_block`. If a block type is missing from this map, the op fails Zod validation.
- **Test runner**: Uses Node's built-in `node:test` with `tsx`. Tests run via `pnpm --filter @ai-site-editor/orchestrator test`. Use `--test-name-pattern` to filter.
