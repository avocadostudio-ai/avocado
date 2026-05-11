# Ops Engine Internals

Use this section to reason about fixes without re-reading source files. Only read source when the bug is outside what's documented here.

## Atomicity model

`applyOpsAtomically()` clones the session draft into a staged `Map<string, PageDoc>`, applies all ops sequentially to the staged copy, and persists only on full success. Any `throw` inside the loop discards the entire batch — no partial apply is possible.

After the loop, if `touchedSlugs` and `deletedSlugs` are both empty and `orderChanged` is false, it throws "Edit plan produced no changes". Special case: if all ops were skipped (via `empty_patch` / `unchanged_value`), it throws "No effective prop change across plan."

## Operation signatures (all 15 op types)

| Op | Required fields | Key behavior |
|----|----------------|--------------|
| `create_page` | `page: PageDoc` | Adds page to staged map. No duplicate slug check (Map overwrites). |
| `add_block` | `pageSlug`, `block: {id, type, props}` | Appends to end if no `afterBlockId`. Duplicate `id` -> throw. Fuzzy `afterBlockId` matching (see below). Validates props via Zod or manifest. |
| `update_props` | `pageSlug`, `blockId`, `patch` | Deep-merges array-of-objects by index. Unwraps `.props` wrapper if present. Unknown patch keys -> throw. Empty patch -> skip (`empty_patch`). No effective change -> skip (`unchanged_value`). |
| `remove_block` | `pageSlug`, `blockId` | Splices block out. Missing `blockId` -> throw. |
| `move_block` | `pageSlug`, `blockId`, optional `afterBlockId` | No `afterBlockId` -> moves to top (unshift). Missing refs -> throw. |
| `duplicate_block` | `pageSlug`, `blockId`, optional `toPageSlug`, `newBlockId`, `afterBlockId` | Clones block with unique ID. Can target a different page via `toPageSlug`. |
| `add_item` | `pageSlug`, `blockId`, `listKey`, `item`, optional `afterIndex` | Inserts into array prop. No `afterIndex` -> appends. Out-of-range -> throw. |
| `update_item` | `pageSlug`, `blockId`, `listKey`, `index`, `patch` | Shallow-merges patch into item at index. Out-of-range -> throw. |
| `remove_item` | `pageSlug`, `blockId`, `listKey`, `index` | Splices item out. Out-of-range -> throw. |
| `move_item` | `pageSlug`, `blockId`, `listKey`, `index`, optional `afterIndex` | Removes then re-inserts. Adjusts `afterIndex` when it's past the removed position. |
| `rename_page` | `pageSlug`, `newPageSlug`, optional `newTitle` | Validates slug, rebuilds Map to preserve nav order, rewrites route links across ALL pages (href props + markdown bodies). Same slug -> throw. |
| `remove_page` | `pageSlug` | Cannot remove `/` (home). Cannot remove last page. |
| `move_page` | `pageSlug`, optional `afterPageSlug` | Home page cannot be moved. Rebuilds Map order. |
| `duplicate_page` | `pageSlug`, optional `newPageSlug`, `newTitle`, `afterPageSlug` | Deep-clones page, assigns unique block IDs, inserts after source or `afterPageSlug`. |
| `update_page_meta` | `pageSlug`, `patch: {title?, description?, ogImage?}` | Merges into `page.meta`. Empty string = delete key. No effective change -> throw. |

## Key behaviors

**Fuzzy `afterBlockId` matching** (`add_block` only): When exact ID lookup fails, extracts the block-type prefix from the ID (e.g. `b_testimonials_about` -> `b_testimonials_`) and scans backwards for a block whose ID starts with that prefix. This handles LLM batch plans that use inconsistent IDs for blocks added in earlier ops.

**`update_props` deep merge**: For array-of-objects props, merges by index — each item in the new array is shallow-merged with the corresponding old item (`{ ...prev, ...item }`). Scalar arrays are replaced wholesale.

**`update_props` `.props` unwrapping**: If `patch.props` is a non-null object, the engine uses `patch.props` as the actual patch instead of `patch` itself. This tolerates LLM output that wraps the patch in an extra `{ props: { ... } }` layer.

**SkippedOps**: `empty_patch` (zero patch keys after filtering) and `unchanged_value` (all patched values identical to current) cause the op to be silently skipped and recorded in `skippedOps[]`. The op is NOT applied but does NOT throw. However, if ALL ops in the batch are skipped, the post-loop check throws "No effective prop change."

**`isStructuralOperation()`**: Returns true for `add_block`, `remove_block`, `move_block`, `duplicate_block`, `add_item`, `remove_item`, `move_item`.

**Route link rewriting** (`rename_page`): After renaming, iterates ALL pages in staged map. For each block's props: rewrites string values in keys containing "href", and rewrites markdown link targets `](...)` in "body" keys. Uses `remapRouteReference()` for exact prefix matching.

**Manifest validation**: When `componentsManifest` is provided, props are validated against the manifest's JSON-schema-like `propsSchema` instead of Zod. If a block type isn't in the manifest, `requireManifestComponent()` throws.

**Progressive apply** (`CHAT_INCREMENTAL_APPLY=1`, enabled by default): The pipeline has two apply paths. Page-structural ops (`create_page`, `rename_page`, `remove_page`, `move_page`, `duplicate_page`) always use atomic apply. All other plans use progressive apply: validates the entire plan atomically first (preflight), rolls back, then replays each op individually with `onOpApplied` callbacks between ops. Full rollback if any op fails during replay. `CHAT_STREAM_APPLY_MIN_STEP_MS` (default 260ms) throttles callback frequency. When debugging `op_applied` event timing or partial-progress UI bugs, check the progressive path — the preflight can succeed but the replay can diverge if session state changes between.

## Error classification (`classifyGuardrailError`)

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

## Deterministic repair flow

When `applyOpsAtomically` throws and the error is classified as `schema_violation`, the pipeline attempts a single auto-repair:

1. Original plan fails -> error classified via `classifyGuardrailError`
2. Only `schema_violation` is repair-eligible (`isDeterministicRepairEligible`)
3. Pipeline calls LLM once with feedback: `"Repair strictly for schema compliance only: {reason}. Do not change user intent or rewrite copy semantics."`
4. Repair uses `forceFullSchemaContracts: true` to tighten schema validation
5. If repaired plan also fails -> returns `guardrail_failure` (outcome: `repair_failed`)

**Repair-ineligible errors** (skip straight to failure): `no_effective_change`, `planner_refusal`, `incomplete_output`, `malformed_output`, `not_found`, `ambiguity`, `internal_error`. Translation scope errors get special feedback emphasizing missing translated fields.

## Plan normalization layer (`normalizePlanCandidate`)

`plan-normalizer.ts` (~1200 lines) transforms raw LLM output into valid operations. This is a top bug source for "wrong op type" symptoms.

**Op name aliases** (30+): `create`->`create_page`, `add`->`add_block`, `update`->`update_props`, `delete`/`remove`->`remove_block`, `move`->`move_block`, `copy_page`->`duplicate_page`, `reorder`->`move_block`, etc. Field `operation`/`action`/`kind` all map to `op`.

**Field name aliases**: `page_slug`/`slug`/`route`/`from` -> `pageSlug`. `new_page_slug`/`targetSlug`/`to` -> `newPageSlug`. `block_id`/`targetBlockId`/`sourceBlockId`/`fromBlockId`/`id` -> `blockId`. `after_block_id` -> `afterBlockId`.

**Prop key remapping**: `question`->`q`, `answer`->`a` (FAQ items). `heading`->`title` (non-Hero blocks only — Hero keeps `heading`). `testimonial`/`review`->`quote`.

**create_page <-> add_block auto-conversion**:
- `create_page` targeting an existing slug -> split into sequential `add_block` ops (preserves block order and IDs)
- `add_block` on a new route + user's message implies page creation -> synthesize `create_page` with the block wrapped in a PageDoc

**Array append detection**: When LLM returns a full array (existing items + new) in an `update_props` patch, normalizer detects the tail items and converts them to separate `add_item` ops to avoid overwriting.

**remove_block auto-conversion**: Detects delete intent from message keywords and converts `remove_block` -> `remove_page` (when no blockId but has pageSlug) or `remove_item` (when targeting a list item, picks ordinal: first/second/last).

**List op path parsing**: Accepts `itemPath`, `item_path`, `arrayProp`, `path` — all resolve to `listKey` + `index`. When `listKey` is missing, infers from the block's array-type props.

**Page slug resolution chain**: normalized route -> page.id match -> "home" special case -> defaultSlug fallback. When `blockId` is missing, tries to infer from block type mention in message + currentPage context.

## Multi-step decomposer

`decomposer.ts` handles multi-step requests (e.g. "create 3 pages for each audience").

- `isMultiStepCandidate()`: heuristic — plural "pages" + verb, "for each/every" patterns, count + "pages"/"blocks" + conjunction
- `decomposeRequest()`: LLM-based breakdown into sequential steps with short labels
- Pipeline stores `ContinuationChain` in session state, processes one step per `runChatPipeline()` call
- Trace shows `continue_chain` execution mode when processing step N of a chain

## Post-apply helpers

**`pickFocusBlockId`** priority: `add_block` -> `duplicate_block` (newBlockId) -> list ops (blockId) -> `move_block` -> `update_props` -> `undefined`.

**`pickUpdatedSlug`**: Single `create_page` -> new slug. `duplicate_page` on current slug -> newPageSlug. `rename_page` on current slug -> newPageSlug. If current slug no longer exists -> first page in home-first order.

## Image resolution

`create_page` hero images are deferred — a placeholder shimmer SVG is set initially, then resolved asynchronously after page creation (DALL-E if API key + explicit gen request -> Unsplash fallback -> keeps placeholder on failure).

`detectImageOps()` scans `update_props` ops for image fields in patches. Filters out explicit user-provided URLs. Resolution priority: DALL-E -> Unsplash -> placeholder. `shouldResolveCreatePageHeroImage()` returns true for empty or non-`http(s)://` URLs.
