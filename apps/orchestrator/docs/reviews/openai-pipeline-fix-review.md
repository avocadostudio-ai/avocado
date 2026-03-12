# OpenAI Pipeline Fix — Architecture Review Document

## Problem Statement

The chat pipeline was designed and tested against Anthropic's Claude API using `tool_use` structured output. When switching to OpenAI (gpt-4o-mini for intent routing, gpt-4o for planning), e2e tests dropped from **21/21 to 7/21**.

The system prompt, context pack, and operation schema are identical between providers. The difference is purely in how the two APIs enforce output structure.

## Root Cause: Structural Enforcement Gap

Anthropic's `tool_use` enforces schema compliance **at generation time** — the model is constrained to produce valid JSON matching the tool's input schema. Required fields are always present, enum values are always valid, nested objects always conform.

OpenAI's `json_schema` with `strict: false` (used because the plan schema has dynamic keys like `patch` that can't be fully described in JSON Schema) provides **no structural enforcement**. The model generates freeform JSON that happens to be valid JSON but doesn't reliably conform to the expected schema. Specifically:

| What Anthropic enforces | What GPT-4o does instead |
|-------------------------|--------------------------|
| `blockId` always present on ops that need it | Omits `blockId` entirely — "knows" which block from context but doesn't emit the ID |
| Correct op granularity (`add_item` vs `add_block`) | Always uses `add_block` even when appending an item to an existing list |
| Correct prop key names (`q`/`a` for FAQ items) | Uses natural language keys (`question`/`answer`) |
| Required array fields present (Stats needs `stats[]`) | Omits required arrays, falls back to whatever the default shape provides |
| Consistent intent routing | Intermittent failures to produce any valid plan after 3 retry attempts |

## Design Decision: Fix the Pipeline, Not the Prompts

Two approaches were considered:

1. **Model-specific prompt engineering** — add OpenAI-specific system instructions, examples, and reminders
2. **Pipeline hardening** — make the normalizer and deterministic planner robust to any model's output

We chose (2) because:
- It benefits all current and future model providers equally
- It reduces LLM dependency for simple operations (faster, cheaper, deterministic)
- It doesn't create divergent prompt maintenance burden
- The fixes are testable without API calls

## Changes Made

### 1. Deterministic Planner Expansion (bypass LLM entirely for simple cases)

**File:** `apps/orchestrator/src/nlp/deterministic-planner.ts`

**Problem:** The deterministic planner only handled cases where `activeBlockId` was set (UI-driven inline edits). All chat-only requests went to the LLM, even trivially simple ones like "change the hero heading to 'X'" or "remove the CTA section."

**What changed:**

`isHighConfidenceDeterministicCase()` gained two new cases:

- **Case 3:** Simple add/remove with a clear block type reference — e.g., "add a FAQ section", "remove the testimonials." No LLM needed; the block type and action are unambiguous.
- **Case 4:** Simple update with a clear block type + quoted value — e.g., "Change the hero heading to 'About Us'." The target block, target field, and new value are all deterministically extractable.

**Trade-off:** More requests bypass the LLM, which means less flexibility for edge cases. Mitigated by keeping the conditions strict (must have unambiguous block type + action/value).

**Risk:** False positives — a message that looks simple but has nuance the deterministic planner can't handle. Current guard: the deterministic planner returns `needs_clarification` if it can't resolve the target, which falls through to the LLM path.

### 2. Item-Level Operation Detection

**File:** `apps/orchestrator/src/nlp/deterministic-planner.ts`

**Problem:** "Add a FAQ question" and "Remove the first FAQ item" were treated as block-level operations. The deterministic planner's add handler always created a new block; the remove handler always removed an entire block.

**What changed:**

- **Add handler:** Before creating a new block, checks if a block of that type already exists on the page. If exactly one exists and `buildListAppendPatch()` can append to it, emits `update_props` with the list appended instead of `add_block`.
- **Remove handler:** Detects item-level keywords (`first`, `second`, `last`, `question`, `item`, etc.) and converts to `remove_item` on the matching list prop.
- **`buildListAppendPatch()`:** Enhanced to extract multiple quoted strings from the message. For FAQ, first quote becomes `q`, second becomes `a`. Previously only extracted one quote and defaulted `a` to "Add answer here."

**Trade-off:** If the user explicitly wants a *second* FAQ section (not a second FAQ item), this would incorrectly append instead. Mitigated by only triggering when exactly one block of that type exists.

### 3. Normalizer Hardening (repair LLM output post-hoc)

**File:** `apps/orchestrator/src/nlp/plan-normalizer.ts`

**Problem:** The normalizer already handled many LLM quirks (op name aliases, slug resolution, patch key normalization) but had gaps that Anthropic's enforcement masked.

**What changed:**

#### 3a. BlockId Inference

When an op requires `blockId` (update_props, remove_block, move_block, duplicate_block) but the LLM omitted it:
1. Infer block type from the op's `type`/`blockType` field or from the user message via `inferBlockTypeFromText()`
2. Find blocks of that type on `currentPage`
3. If exactly one match → use its ID
4. For `update_props`, additional fallback: check which blocks on the page have props matching the patch keys

**Risk:** Ambiguous when multiple blocks of the same type exist. Only fires on single-match (safe) or patch-key-match (reasonably safe).

#### 3b. add_block → add_item Conversion

When the LLM emits `add_block` for a block type that already exists as a single instance on the page, and the new block's props contain a list field matching an existing list on the target block:
- Converts to `add_item`
- Extracts the first item from the list
- Sets the correct `listKey`

This handles GPT-4o's tendency to emit `add_block` with type "FAQAccordion" when it means "append a FAQ item."

#### 3c. remove_block → remove_item Conversion

Same pattern as 3b but for removals. When user message contains item-level language and the target block has list props, converts to `remove_item` with positional detection (first/second/third/last).

#### 3d. add_item Key Remapping

The normalizer already remapped keys for `update_item` patches but not for `add_item` items. Added the same remapping: `question→q`, `answer→a`, `testimonial→quote`, `review→quote`.

### 4. Missing Default Props

**File:** `apps/orchestrator/src/nlp/plan-normalizer.ts`

**Problem:** `defaultPropsForType("Stats")` had no specific case — fell through to the generic default which returns `{ title, description, ctaText, ctaHref }`. The Stats block schema requires a `stats` array. Any deterministically-created Stats block immediately failed Zod validation.

**Fix:** Added `Stats` case with `{ title, stats: [{value, label}, ...] }`.

### 5. Text Extraction Improvements

**File:** `apps/orchestrator/src/nlp/deterministic-planner.ts`

#### 5a. `quotedText()` — Single Quote Support

Only matched double quotes `"..."`. Many user messages use single quotes `'...'`. Added single-quote fallback.

#### 5b. `inferSimpleFieldPatchFromMessage()` — Field Coverage

Only recognized `title`, `description`, `cta text` as field hints. Added `heading`, `subheading`, `button text`. Also added smart-quote normalization (curly → straight) so the regex works regardless of input source.

#### 5c. `inferBlockTypeFromText()` — Typo Tolerance

Added common misspellings and alternative phrasings:
- `testomonial` → Testimonials
- `feture` → FeatureGrid
- `call-to-action` / `call to action` → CTA

### 6. Page Creation Heading Override

**File:** `apps/orchestrator/src/nlp/deterministic-planner.ts`

**Problem:** `createPageBlocks()` checks `asksIntentPage = /\b(intent|purpose|mission)\b/` to decide the hero heading. The message "Create a page at /about... explaining our **mission**" triggered this, overriding the user's explicit "hero titled 'About Us'" with "Purpose of This Site."

**Fix:** Extract explicit hero heading from the message first (regex: `hero titled 'X'`, `hero called 'X'`, `hero with heading 'X'`). Only fall back to `asksIntentPage` heuristic if no explicit heading was given.

### 7. Page Delete Guard

**File:** `apps/orchestrator/src/nlp/deterministic-planner.ts`

**Problem:** `asksPageDelete` regex `/\b(delete|remove)\b.*\bpage\b/` matched "remove the CTA section from this **page**" — treating a block removal as a page deletion.

**Fix:** Added `&& !inferBlockTypeFromText(cleanMessage)` guard. If the message references a specific block type, it's not asking to delete the page.

## Test Results

| Provider | Before | After |
|----------|--------|-------|
| OpenAI (gpt-4o) | 7/21 | **21/21** |
| Unit tests | 78/78 | **78/78** |

## Architectural Observations for Review

### 1. Deterministic Planner Scope Creep

The deterministic planner has grown from "handle inline UI edits" to "handle most simple chat requests." This is good for latency and cost (no LLM call needed), but the `isHighConfidenceDeterministicCase()` function is becoming a complex decision tree. Consider whether this should be formalized into a proper rule engine with explicit priority ordering.

### 2. Normalizer as Schema Migration Layer

The normalizer is effectively a schema migration/coercion layer that transforms arbitrary LLM output into valid operations. This pattern works but has no formal contract — it's a collection of if-else repairs. As more providers are added, this will grow. Consider:
- Defining a "raw plan" type (loose) vs "normalized plan" type (strict)
- Running Zod validation *after* normalization and logging what the normalizer fixed
- Tracking normalizer hit rates per provider to understand which models need which repairs

### 3. Block Type Resolution Chain

Block type is resolved through multiple overlapping mechanisms:
- `inferBlockTypeFromText()` (keyword matching on user message)
- `inferAddedBlockTypeFromMessage()` (regex extraction after add/create verbs)
- `resolveBlockRef()` (ID/type/ordinal matching against page blocks)
- Normalizer's type alias table
- The LLM's own type field

These can disagree. Currently there's no explicit priority ordering — whichever runs first wins. This should be documented or consolidated.

### 4. Single-Instance Assumption

The add→item and remove→item conversions assume "if exactly one block of this type exists, the user means that one." This is correct for most sites but will break on pages with e.g. two FeatureGrid blocks. Consider adding a disambiguation flow: "Which features section — 'Key Features' or 'Advanced Features'?"

### 5. Quoted Text Parsing Fragility

Multiple functions parse quoted text differently:
- `quotedText()` — first double-quoted, then single-quoted string
- `buildListAppendPatch()` — all single/double-quoted strings via `matchAll`
- `inferSimpleFieldPatchFromMessage()` — regex with optional quote delimiters
- `createPageBlocks()` — new regex for "hero titled 'X'"

These should ideally share a single `extractQuotedStrings(message)` utility.

### 6. No Regression Safety Net for Provider Switching

There's no automated test that runs the same suite against both Anthropic and OpenAI to catch provider-specific regressions. The e2e test file has `provider: "openai"` hardcoded. Consider parameterizing it or running both in CI.

## Follow-up Hardening (Structured Outputs)

The planner now explicitly distinguishes three non-success model-output paths before normalization:

- `planner_refusal`: model refuses to provide plan content.
- `incomplete_output`: model returns empty/incomplete plan output.
- `malformed_output`: output is non-JSON or fails the raw-plan shape gate.

`malformed_output` remains retryable in the planning loop, while refusal/incomplete are treated as non-repairable planner outcomes. The pipeline emits dedicated telemetry outcome/reason-category pairs for these states so they can be tracked independently from schema guardrail failures.
