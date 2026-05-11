# Test Patterns & Common Pitfalls

## Targeted test commands by bug class

| Bug class | Command |
|-----------|---------|
| Ops engine: specific op (e.g. `add_block`) | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "ops-engine: add_block"` |
| Ops engine: atomicity | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "ops-engine: atomicity"` |
| Ops engine: error classification | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "classifyGuardrail\|toErrorDetail"` |
| Ops engine: skipped ops / no-op | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "no.effective\|unchanged"` |
| HTTP /ops endpoint | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "add_block:\|update_props:\|remove_block:\|move_block:\|create_page:\|rename_page:\|remove_page:\|duplicate_page:\|add_item:\|update_item:\|remove_item:\|move_item:\|atomicity:"` |
| Deterministic intent | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "inferDeterministicIntent\|isHighConfidence"` |
| Batch detection | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "isBatchAdd\|isBatchRemove\|isBatchReorder\|batch"` |
| Plan normalization | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "normalizePlanCandidate"` |
| Deterministic compilation | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "compileDeterministicPlan"` |
| OpenAI planner | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "generatePlanWithOpenAI\|parseIntentWithOpenAI\|plannerContextPack\|buildPlannerSchema"` |
| Pipeline E2E | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "chat pending-plan\|chat auto\|chat applies\|chat returns\|chat stream\|chat telemetry\|chat discard\|chat uses"` |
| Translation | `pnpm --filter @ai-site-editor/orchestrator test -- --test-name-pattern "translation coverage"` |

## Test file locations by bug class

| Bug class | Test file |
|-----------|-----------|
| Deterministic intent / batch detection | `apps/orchestrator/src/nlp-ops.test.ts` |
| Ops engine apply failures | `apps/orchestrator/src/ops/ops-engine.test.ts` |
| Plan normalization | `apps/orchestrator/src/nlp-ops.test.ts` |
| Full pipeline (end-to-end) | `apps/orchestrator/src/chat-pipeline-integration.test.ts` |
| OpenAI planner contract | `apps/orchestrator/src/planner-openai.test.ts` |
| HTTP /ops endpoint | `apps/orchestrator/src/apply-ops.test.ts` |
| Translation | `apps/orchestrator/src/chat/translation-coverage.test.ts` |

## Test patterns — use existing helpers

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

## Common Pitfalls

- **Deterministic path vs LLM path**: If `plan_ready` is <10ms in the timeline, the plan came from `inferDeterministicIntent()` + `compileDeterministicPlan()`, NOT from the LLM. Fix the deterministic planner, not the prompt.
- **Strict primary-op mode**: `isChatStrictPrimaryOpMode()` limits plans to 1 operation unless a batch override returns `true`. The batch override check is: `isBatchAddRequest() || isBatchRemoveRequest() || isBatchReorderRequest() || isPageWideRewriteRequest()`. If a multi-op request is being truncated to 1 op, check whether the user's phrasing is matched by one of these detectors. Common gap: new operation patterns (reorder, rearrange, etc.) that need multi-op but aren't covered by any batch detector — add a new `isBatch*Request()` function and wire it into `batchOverride` in both `planner.ts` and `anthropic-planner.ts`.
- **Block type inference**: `inferBlockTypeFromText()` does fuzzy matching (e.g. "cardgrid" -> "CardGrid"). If a block type isn't recognized, the op may be dropped during normalization.
- **Default props**: `defaultPropsForType()` provides minimum valid props for `add_block`. If a block type is missing from this map, the op fails Zod validation.
- **Image placeholders**: `create_page` hero images use a shimmer SVG placeholder initially, then resolve async (DALL-E -> Unsplash -> keeps placeholder). If a user reports missing images after page creation, check the deferred resolution path, not the ops engine.
- **Normalization surprises**: `normalizePlanCandidate` silently converts ops (e.g. `create_page` on existing slug -> `add_block`, `remove_block` without blockId -> `remove_page`). If an op type in the trace doesn't match what the LLM returned, check normalization before the planner.
- **Test runner**: Uses Node's built-in `node:test` with `tsx`. Tests run via `pnpm --filter @ai-site-editor/orchestrator test`. Use `--test-name-pattern` to filter.
- **Tests silently not running**: The dev server is always running on port 4200. Some test files (e.g. `nlp-ops.test.ts`) import `app` from `./index.js` which can cause silent failures if the import chain triggers side effects. If you add a test and the total test count doesn't increase, run the specific file directly with `NODE_ENV=test npx tsx --test <file>` to see import/runtime errors. Always verify your new test appears in the output — don't assume it ran just because there are no failures.
- **Batch override coverage gap**: When a new multi-op request pattern isn't covered by any `isBatch*Request()` detector, `isChatStrictPrimaryOpMode()` silently truncates the LLM plan to 1 op. The trace will show `outcome: applied` with `opCount: 1` — it looks like success but the user only sees one operation applied. Always check whether the user's prompt matches an existing batch detector before looking at the planner itself.
