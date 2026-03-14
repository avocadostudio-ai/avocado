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

## Ops Engine Internals

Use this section to reason about fixes without re-reading source files. Only read source when the bug is outside what's documented here.

### Atomicity model

`applyOpsAtomically()` clones the session draft into a staged `Map<string, PageDoc>`, applies all ops sequentially to the staged copy, and persists only on full success. Any `throw` inside the loop discards the entire batch — no partial apply is possible.

After the loop, if `touchedSlugs` and `deletedSlugs` are both empty and `orderChanged` is false, it throws "Edit plan produced no changes". Special case: if all ops were skipped (via `empty_patch` / `unchanged_value`), it throws "No effective prop change across plan."

### Operation signatures (all 15 op types)

| Op | Required fields | Key behavior |
|----|----------------|--------------|
| `create_page` | `page: PageDoc` | Adds page to staged map. No duplicate slug check (Map overwrites). |
| `add_block` | `pageSlug`, `block: {id, type, props}` | Appends to end if no `afterBlockId`. Duplicate `id` → throw. Fuzzy `afterBlockId` matching (see below). Validates props via Zod or manifest. |
| `update_props` | `pageSlug`, `blockId`, `patch` | Deep-merges array-of-objects by index. Unwraps `.props` wrapper if present. Unknown patch keys → throw. Empty patch → skip (`empty_patch`). No effective change → skip (`unchanged_value`). |
| `remove_block` | `pageSlug`, `blockId` | Splices block out. Missing `blockId` → throw. |
| `move_block` | `pageSlug`, `blockId`, optional `afterBlockId` | No `afterBlockId` → moves to top (unshift). Missing refs → throw. |
| `duplicate_block` | `pageSlug`, `blockId`, optional `toPageSlug`, `newBlockId`, `afterBlockId` | Clones block with unique ID. Can target a different page via `toPageSlug`. |
| `add_item` | `pageSlug`, `blockId`, `listKey`, `item`, optional `afterIndex` | Inserts into array prop. No `afterIndex` → appends. Out-of-range → throw. |
| `update_item` | `pageSlug`, `blockId`, `listKey`, `index`, `patch` | Shallow-merges patch into item at index. Out-of-range → throw. |
| `remove_item` | `pageSlug`, `blockId`, `listKey`, `index` | Splices item out. Out-of-range → throw. |
| `move_item` | `pageSlug`, `blockId`, `listKey`, `index`, optional `afterIndex` | Removes then re-inserts. Adjusts `afterIndex` when it's past the removed position. |
| `rename_page` | `pageSlug`, `newPageSlug`, optional `newTitle` | Validates slug, rebuilds Map to preserve nav order, rewrites route links across ALL pages (href props + markdown bodies). Same slug → throw. |
| `remove_page` | `pageSlug` | Cannot remove `/` (home). Cannot remove last page. |
| `move_page` | `pageSlug`, optional `afterPageSlug` | Home page cannot be moved. Rebuilds Map order. |
| `duplicate_page` | `pageSlug`, optional `newPageSlug`, `newTitle`, `afterPageSlug` | Deep-clones page, assigns unique block IDs, inserts after source or `afterPageSlug`. |
| `update_page_meta` | `pageSlug`, `patch: {title?, description?, ogImage?}` | Merges into `page.meta`. Empty string = delete key. No effective change → throw. |

### Key behaviors

**Fuzzy `afterBlockId` matching** (`add_block` only): When exact ID lookup fails, extracts the block-type prefix from the ID (e.g. `b_testimonials_about` → `b_testimonials_`) and scans backwards for a block whose ID starts with that prefix. This handles LLM batch plans that use inconsistent IDs for blocks added in earlier ops.

**`update_props` deep merge**: For array-of-objects props, merges by index — each item in the new array is shallow-merged with the corresponding old item (`{ ...prev, ...item }`). Scalar arrays are replaced wholesale.

**`update_props` `.props` unwrapping**: If `patch.props` is a non-null object, the engine uses `patch.props` as the actual patch instead of `patch` itself. This tolerates LLM output that wraps the patch in an extra `{ props: { ... } }` layer.

**SkippedOps**: `empty_patch` (zero patch keys after filtering) and `unchanged_value` (all patched values identical to current) cause the op to be silently skipped and recorded in `skippedOps[]`. The op is NOT applied but does NOT throw. However, if ALL ops in the batch are skipped, the post-loop check throws "No effective prop change."

**`isStructuralOperation()`**: Returns true for `add_block`, `remove_block`, `move_block`, `duplicate_block`, `add_item`, `remove_item`, `move_item`.

**Route link rewriting** (`rename_page`): After renaming, iterates ALL pages in staged map. For each block's props: rewrites string values in keys containing "href", and rewrites markdown link targets `](...)` in "body" keys. Uses `remapRouteReference()` for exact prefix matching.

**Manifest validation**: When `componentsManifest` is provided, props are validated against the manifest's JSON-schema-like `propsSchema` instead of Zod. If a block type isn't in the manifest, `requireManifestComponent()` throws.

**Progressive apply** (`CHAT_INCREMENTAL_APPLY=1`, enabled by default): The pipeline has two apply paths. Page-structural ops (`create_page`, `rename_page`, `remove_page`, `move_page`, `duplicate_page`) always use atomic apply. All other plans use progressive apply: validates the entire plan atomically first (preflight), rolls back, then replays each op individually with `onOpApplied` callbacks between ops. Full rollback if any op fails during replay. `CHAT_STREAM_APPLY_MIN_STEP_MS` (default 260ms) throttles callback frequency. When debugging `op_applied` event timing or partial-progress UI bugs, check the progressive path — the preflight can succeed but the replay can diverge if session state changes between.

### Error classification (`classifyGuardrailError`)

| Category | Pattern matches in error string |
|----------|-------------------------------|
| `no_effective_change` | "No effective prop change" |
| `planner_refusal` | "Refused planning output" |
| `incomplete_output` | "incomplete planning output", "returned no planning output" |
| `malformed_output` | "did not return json", "malformed json", "raw planner output shape is invalid" |
| `not_found` | "page not found", "blockid", "afterblockid", "not found" |
| `ambiguity` | "ambiguous", "clarify", "unclear" |
| `schema_violation` | "invalid", "required", "unknown props", "out of range", "must be" |
| `internal_error` | (fallback — no pattern matched) |

Only `schema_violation` is eligible for deterministic repair (`isDeterministicRepairEligible`).

### Deterministic repair flow

When `applyOpsAtomically` throws and the error is classified as `schema_violation`, the pipeline attempts a single auto-repair:

1. Original plan fails → error classified via `classifyGuardrailError`
2. Only `schema_violation` is repair-eligible (`isDeterministicRepairEligible`)
3. Pipeline calls LLM once with feedback: `"Repair strictly for schema compliance only: {reason}. Do not change user intent or rewrite copy semantics."`
4. Repair uses `forceFullSchemaContracts: true` to tighten schema validation
5. If repaired plan also fails → returns `guardrail_failure` (outcome: `repair_failed`)

**Repair-ineligible errors** (skip straight to failure): `no_effective_change`, `planner_refusal`, `incomplete_output`, `malformed_output`, `not_found`, `ambiguity`, `internal_error`. Translation scope errors get special feedback emphasizing missing translated fields.

### Plan normalization layer (`normalizePlanCandidate`)

`plan-normalizer.ts` (~1200 lines) transforms raw LLM output into valid operations. This is a top bug source for "wrong op type" symptoms.

**Op name aliases** (30+): `create`→`create_page`, `add`→`add_block`, `update`→`update_props`, `delete`/`remove`→`remove_block`, `move`→`move_block`, `copy_page`→`duplicate_page`, `reorder`→`move_block`, etc. Field `operation`/`action`/`kind` all map to `op`.

**Field name aliases**: `page_slug`/`slug`/`route`/`from` → `pageSlug`. `new_page_slug`/`targetSlug`/`to` → `newPageSlug`. `block_id`/`targetBlockId`/`sourceBlockId`/`fromBlockId`/`id` → `blockId`. `after_block_id` → `afterBlockId`.

**Prop key remapping**: `question`→`q`, `answer`→`a` (FAQ items). `heading`→`title` (non-Hero blocks only — Hero keeps `heading`). `testimonial`/`review`→`quote`.

**create_page ↔ add_block auto-conversion**:
- `create_page` targeting an existing slug → split into sequential `add_block` ops (preserves block order and IDs)
- `add_block` on a new route + user's message implies page creation → synthesize `create_page` with the block wrapped in a PageDoc

**Array append detection**: When LLM returns a full array (existing items + new) in an `update_props` patch, normalizer detects the tail items and converts them to separate `add_item` ops to avoid overwriting.

**remove_block auto-conversion**: Detects delete intent from message keywords and converts `remove_block` → `remove_page` (when no blockId but has pageSlug) or `remove_item` (when targeting a list item, picks ordinal: first/second/last).

**List op path parsing**: Accepts `itemPath`, `item_path`, `arrayProp`, `path` — all resolve to `listKey` + `index`. When `listKey` is missing, infers from the block's array-type props.

**Page slug resolution chain**: normalized route → page.id match → "home" special case → defaultSlug fallback. When `blockId` is missing, tries to infer from block type mention in message + currentPage context.

### Multi-step decomposer

`decomposer.ts` handles multi-step requests (e.g. "create 3 pages for each audience").

- `isMultiStepCandidate()`: heuristic — plural "pages" + verb, "for each/every" patterns, count + "pages"/"blocks" + conjunction
- `decomposeRequest()`: LLM-based breakdown into sequential steps with short labels
- Pipeline stores `ContinuationChain` in session state, processes one step per `runChatPipeline()` call
- Trace shows `continue_chain` execution mode when processing step N of a chain

### Post-apply helpers

**`pickFocusBlockId`** priority: `add_block` → `duplicate_block` (newBlockId) → list ops (blockId) → `move_block` → `update_props` → `undefined`.

**`pickUpdatedSlug`**: Single `create_page` → new slug. `duplicate_page` on current slug → newPageSlug. `rename_page` on current slug → newPageSlug. If current slug no longer exists → first page in home-first order.

### Image resolution

`create_page` hero images are deferred — a placeholder shimmer SVG is set initially, then resolved asynchronously after page creation (DALL-E if API key + explicit gen request → Unsplash fallback → keeps placeholder on failure).

`detectImageOps()` scans `update_props` ops for image fields in patches. Filters out explicit user-provided URLs. Resolution priority: DALL-E → Unsplash → placeholder. `shouldResolveCreatePageHeroImage()` returns true for empty or non-`http(s)://` URLs.

## Diagnosis Workflow

### Step 1: Parse the trace

Extract these fields from the debug log:

| Field | What it tells you |
|-------|------------------|
| `outcome` | `applied` = ops ran; `apply_failed` = ops threw; `planning_exhausted` = LLM failed; `repair_failed` = auto-repair also failed; `needs_clarification` = planner refused/returned clarification; `planning_missing` = planner returned null; `no_effective_change` = all ops skipped; `planner_exception` = LLM client threw |
| `opCount` | Number of ops the planner generated |
| `ops` | Comma-separated op types that were generated |
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

Run ONLY the tests relevant to the bug class. Do NOT run the full suite.

**Bug class → targeted test command:**

| Bug class | Command |
|-----------|---------|
| Ops engine: specific op (e.g. `add_block`) | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "ops-engine: add_block"` |
| Ops engine: atomicity | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "ops-engine: atomicity"` |
| Ops engine: error classification | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "classifyGuardrail\|toErrorDetail"` |
| Ops engine: skipped ops / no-op | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "no.effective\|unchanged"` |
| HTTP /ops endpoint | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "add_block:\|update_props:\|remove_block:\|move_block:\|create_page:\|rename_page:\|remove_page:\|duplicate_page:\|add_item:\|update_item:\|remove_item:\|move_item:\|atomicity:"` (runs `apply-ops.test.ts` tests) |
| Deterministic intent | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "inferDeterministicIntent\|isHighConfidence"` |
| Batch detection | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "isBatchAdd\|isBatchRemove\|isBatchReorder\|batch"` |
| Plan normalization | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "normalizePlanCandidate"` |
| Deterministic compilation | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "compileDeterministicPlan"` |
| OpenAI planner | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "generatePlanWithOpenAI\|parseIntentWithOpenAI\|plannerContextPack\|buildPlannerSchema"` |
| Pipeline E2E | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "chat pending-plan\|chat auto\|chat applies\|chat returns\|chat stream\|chat telemetry\|chat discard\|chat uses"` |
| Translation | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "translation coverage"` |

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
| HTTP /ops endpoint | `apps/orchestrator/src/apply-ops.test.ts` |
| Translation | `apps/orchestrator/src/chat/translation-coverage.test.ts` |

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

- **Deterministic path vs LLM path**: If `plan_ready` is <10ms in the timeline, the plan came from `inferDeterministicIntent()` + `compileDeterministicPlan()`, NOT from the LLM. Fix the deterministic planner, not the prompt.
- **Strict primary-op mode**: `isChatStrictPrimaryOpMode()` limits plans to 1 operation unless a batch override returns `true`. The batch override check is: `isBatchAddRequest() || isBatchRemoveRequest() || isBatchReorderRequest() || isPageWideRewriteRequest()`. If a multi-op request is being truncated to 1 op, check whether the user's phrasing is matched by one of these detectors. Common gap: new operation patterns (reorder, rearrange, etc.) that need multi-op but aren't covered by any batch detector — add a new `isBatch*Request()` function and wire it into `batchOverride` in both `planner.ts` and `anthropic-planner.ts`.
- **Block type inference**: `inferBlockTypeFromText()` does fuzzy matching (e.g. "cardgrid" -> "CardGrid"). If a block type isn't recognized, the op may be dropped during normalization.
- **Default props**: `defaultPropsForType()` provides minimum valid props for `add_block`. If a block type is missing from this map, the op fails Zod validation.
- **Image placeholders**: `create_page` hero images use a shimmer SVG placeholder initially, then resolve async (DALL-E → Unsplash → keeps placeholder). If a user reports missing images after page creation, check the deferred resolution path, not the ops engine.
- **Normalization surprises**: `normalizePlanCandidate` silently converts ops (e.g. `create_page` on existing slug → `add_block`, `remove_block` without blockId → `remove_page`). If an op type in the trace doesn't match what the LLM returned, check normalization before the planner.
- **Test runner**: Uses Node's built-in `node:test` with `tsx`. Tests run via `pnpm --filter @ai-site-editor/orchestrator test`. Use `--test-name-pattern` to filter.
- **Tests silently not running**: The dev server is always running on port 4200. Some test files (e.g. `nlp-ops.test.ts`) import `app` from `./index.js` which can cause silent failures if the import chain triggers side effects. If you add a test and the total test count doesn't increase, run the specific file directly with `NODE_ENV=test npx tsx --test <file>` to see import/runtime errors. Always verify your new test appears in the output — don't assume it ran just because there are no failures.
- **Batch override coverage gap**: When a new multi-op request pattern isn't covered by any `isBatch*Request()` detector, `isChatStrictPrimaryOpMode()` silently truncates the LLM plan to 1 op. The trace will show `outcome: applied` with `opCount: 1` — it looks like success but the user only sees one operation applied. Always check whether the user's prompt matches an existing batch detector before looking at the planner itself.
