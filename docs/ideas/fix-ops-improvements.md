# Fix-Ops Skill — Further Improvements

Prioritized recommendations for `.claude/skills/fix-ops/SKILL.md` after the initial rewrite (ops engine internals + targeted tests).

## P0: Add normalization layer reference

The 1200-line `plan-normalizer.ts` is the #1 source of "wrong op type" bugs and isn't documented at all. Claude re-reads it every time.

Encode:
- **Op name aliases** (30+): `create`→`create_page`, `add`→`add_block`, `delete`→`remove_block`, `copy_page`→`duplicate_page`, etc.
- **Field name aliases**: `page_slug`/`slug`/`route`/`from` → `pageSlug`; `block_id`/`targetBlockId`/`sourceBlockId`/`id` → `blockId`
- **Prop key remapping**: `question`→`q`, `answer`→`a` (FAQ); `heading`→`title` (non-Hero); `testimonial`/`review`→`quote`
- **create_page ↔ add_block conversion**: `create_page` on existing slug → split into `add_block` ops; `add_block` on new route + create intent → synthesize `create_page`
- **Array append detection**: when LLM returns full array (existing + new), normalizer extracts tail and converts to `add_item` ops
- **remove_block → remove_page/remove_item**: auto-conversion based on context + message keywords
- **List op path parsing**: `itemPath`, `arrayProp`, `path` all resolve to `listKey` + `index`
- **Page slug resolution chain**: normalized route → page.id match → "home" special case → defaultSlug

## P1: Add deterministic repair flow

When `outcome: apply_failed` with `schema_violation`, the pipeline auto-repairs. Without this, Claude chases bugs the pipeline already handles.

Encode:
- Only `schema_violation` errors are repair-eligible (`isDeterministicRepairEligible`)
- Single repair attempt: original plan fails → one LLM repair call → if still fails, returns `guardrail_failure`
- Repair feedback: `"Repair strictly for schema compliance only: {reason}"`
- Translation scope errors get different feedback emphasizing missing translated fields
- Repair uses `forceFullSchemaContracts: true`
- Repair-ineligible: `no_effective_change`, non-schema errors, incomplete/refused output

## P2: Add progressive apply behavior

Two apply paths exist (atomic vs incremental). Needed for debugging `op_applied` event issues.

Encode:
- Enabled by default (`CHAT_INCREMENTAL_APPLY=1`)
- Page-structural ops force atomic-only (no progressive)
- Flow: validates atomically first → rolls back → replays each op with `onOpApplied` callbacks → full rollback on failure
- `CHAT_STREAM_APPLY_MIN_STEP_MS` (default 260ms) throttles callback frequency

## P3: Document decomposer / multi-step chains

`decomposer.ts` is a new module not referenced in the skill. `continue_chain` in traces will confuse Claude.

Encode:
- `isMultiStepCandidate()` heuristic: plural "pages" + verb, "for each/every", count + conjunction
- `decomposeRequest()` breaks prompt into sequential steps via LLM
- Pipeline stores `ContinuationChain` in session state, processes one step per call
- `continue_chain` execution mode in traces = processing step N of a chain

## P4: Expand symptom table with more outcome values

Current Step 2 table doesn't cover these trace outcomes:
- `repair_failed` — initial plan had schema violation, auto-repair also failed
- `needs_clarification` — planner refused or returned clarification
- `planning_missing` — planner returned null
- `no_effective_change` — all ops skipped (unchanged values)
- `planner_exception` — demo planner or LLM client threw

## P5: Add image resolution to common pitfalls

Recurring bug class, zero coverage:
- `create_page` hero images are deferred: placeholder SVG first, async resolution after
- `detectImageOps()` scans update_props for image paths; filters out explicit user URLs
- Resolution priority: DALL-E (if API key + explicit gen request) → Unsplash → keeps placeholder
- `shouldResolveCreatePageHeroImage()` returns true for empty or non-http URLs

## Not worth adding (skip)

- **Session state architecture** — too low-level for ops debugging, rare bug source
- **Plan normalization for UI** (strip IDs, rewrite summaries) — cosmetic, not a bug source
- **Effective slug resolution from activeBlockId** — implicitly covered by deterministic planner docs
