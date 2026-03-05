# Guardrail Schema v1 Specification

## Scope

This spec defines guardrails for AI-generated edits in the current architecture:

- Data model: `PageDoc.blocks[]` (flat block list).
- Enforced through orchestrator plan parsing + operation validation + block prop validation.
- Covers:
  1. Field-level constraints per block type
  2. Error taxonomy and response contract
  3. Auto-repair retry strategy and stopping rules
  4. Acceptance tests for valid/invalid scenarios

## Locked Decisions

1. Hard-blocking schema enforcement for invalid operations/props.
2. MVP includes structural/schema guardrails only (no brand/policy pack yet).
3. One bounded auto-repair retry for deterministic schema errors only.
4. No semantic rewrites during auto-repair.
5. If repair fails, return `needs_clarification` with precise violating fields.

## 1) Field-Level Constraints Per Block Type

### Shared Rules

- All block instances must include:
  - `id: string` (non-empty)
  - `type: BlockType` (one of allowed block types)
  - `props: object`
- Strings use `min(1)` unless marked optional.
- Array fields use `min(1)` unless explicitly stated otherwise.

### Block Constraints

#### `Hero`

- Required:
  - `heading: string`
  - `subheading: string`
  - `ctaText: string`
  - `ctaHref: string`
  - `imageUrl: string`
  - `imageAlt: string`
- Optional:
  - `secondaryCtaText: string`
  - `secondaryCtaHref: string`

#### `FeatureGrid`

- Required:
  - `title: string`
  - `features: FeatureItem[]` with at least 1 item
- `FeatureItem`:
  - `title: string`
  - `description: string`

#### `Testimonials`

- Required:
  - `title: string`
  - `items: TestimonialItem[]` with at least 1 item
- `TestimonialItem`:
  - `quote: string`
  - `author: string`

#### `FAQAccordion`

- Required:
  - `title: string`
  - `items: FAQItem[]` with at least 1 item
- `FAQItem`:
  - `q: string`
  - `a: string`

#### `CTA`

- Required:
  - `title: string`
  - `description: string`
  - `ctaText: string`
  - `ctaHref: string`

#### `Card`

- Required:
  - `title: string`
  - `description: string`
  - `ctaText: string`
  - `ctaHref: string`

#### `CardGrid`

- Required:
  - `title: string`
  - `cards: CardItem[]` with at least 1 item
- `CardItem`:
  - `title: string`
  - `description: string`
  - `ctaText: string`
  - `ctaHref: string`

#### `RichText`

- Required:
  - `body: string`
- Optional:
  - `title: string` (can be empty)

## Operation-Level Guardrails

`EditPlan.ops[]` supports only these operations:

- Page: `create_page`, `rename_page`, `remove_page`, `move_page`, `duplicate_page`
- Block: `add_block`, `update_props`, `remove_block`, `move_block`, `duplicate_block`
- List item: `add_item`, `update_item`, `remove_item`, `move_item`

Disallowed behavior:

- Unknown `op` values
- Missing required op fields
- Invalid field types (e.g. non-integer indices)
- Empty ops array for direct ops endpoint

## 2) Error Taxonomy and Response Contract

## Error Taxonomy

### `schema_violation`

The plan/op/props fail structural validation.

Examples:

- Unknown operation
- Invalid block type
- Missing required prop
- Empty required string
- Array below minimum length
- Invalid item index

### `ambiguity`

Request intent is unclear; no safe deterministic edit can be chosen.

Examples:

- Multiple possible targets with no active block/context
- Request lacks required selection context

### `not_found`

Referenced page/block/item does not exist.

Examples:

- `page not found`
- `selected block not found on current page`

### `no_effective_change`

Request is valid but produces no net changes.

Example:

- New content equals existing content

### `internal_error`

Unexpected runtime error during planning/apply.

## Response Contract

### `/chat` and `/chat/stream` final result (success)

```json
{
  "status": "applied",
  "summary": "Applied user-facing summary",
  "changes": ["change 1", "change 2"],
  "mentionedSlugs": ["/"],
  "previewVersion": 12,
  "focusBlockId": "b_hero_home",
  "updatedSlug": "/",
  "plannerSource": "openai",
  "modelUsed": "gpt-4o",
  "modelKey": "balanced"
}
```

### Clarification result

```json
{
  "status": "needs_clarification",
  "summary": "Question for the user",
  "changes": [],
  "suggestions": ["option A", "option B"],
  "previewVersion": 12
}
```

### Validation/safety failure result

```json
{
  "status": "validation_error",
  "summary": "I could not apply that change safely.",
  "changes": [],
  "validationErrors": [
    "schema_violation: Hero.ctaHref is required"
  ],
  "previewVersion": 12
}
```

### `/ops` endpoint failure shape

```json
{
  "error": "invalid ops payload"
}
```

Implementation note:

- Current `/ops` uses `{ error: string }`.
- `validationErrors` is currently part of `/chat`-family payloads.

## 3) Auto-Repair Retry Strategy and Stopping Rules

## Eligibility for Auto-Repair (Deterministic Only)

Auto-repair may attempt exactly one correction pass when failures are structural and local, such as:

1. Missing required field with inferable fallback from context.
2. Type normalization (`number` string to integer where safe).
3. Enum normalization where a single exact match exists.
4. Patch cleanup for unknown keys in a strict block shape.

Not eligible:

1. Semantic rewrites of copy/tone/content meaning.
2. Ambiguous target selection.
3. Cross-entity inference requiring user intent assumptions.
4. Multi-step transformations that can change intent.

## Retry Flow

1. Generate plan.
2. Validate plan + props.
3. If valid: apply.
4. If invalid and auto-repair eligible:
  - run one repair pass
  - revalidate
5. If revalidation passes: apply repaired plan.
6. If revalidation fails:
  - return `needs_clarification` if ambiguity/intent gap
  - else return `validation_error` with precise fields

## Stopping Rules

Stop immediately when any of the following is true:

1. One repair pass has already been used.
2. Validation errors are non-deterministic/ambiguous.
3. Repair would require semantic content invention.
4. Any guardrail violation remains after revalidation.

## 4) Acceptance Tests (Valid/Invalid Scenarios)

## A. Valid Apply

1. `A1` Update Hero heading
- Input: `update_props` for `Hero.heading` non-empty string.
- Expected: `status=applied`, preview version increments, focus block set.

2. `A2` Add FeatureGrid item
- Input: `add_item` on `FeatureGrid.features` with required fields.
- Expected: applied, array length +1.

3. `A3` Move block within page
- Input: valid `move_block`.
- Expected: applied, new order persisted.

## B. Hard-Blocked Schema Violations

1. `B1` Missing required field
- Input: `add_block` Hero without `ctaHref`.
- Expected: rejected (`validation_error` or `/ops` `error`), no state mutation.

2. `B2` Empty required string
- Input: `update_props` set `CTA.title=""`.
- Expected: rejected, no version bump.

3. `B3` Invalid list index
- Input: `update_item` with out-of-range or negative index.
- Expected: rejected, no mutation.

4. `B4` Unknown operation
- Input: `op="replace_page"`.
- Expected: rejected by operation schema.

## C. Clarification Paths

1. `C1` Ambiguous target
- Input: "make this shorter" with no active block and multiple candidates.
- Expected: `status=needs_clarification` + suggestions.

2. `C2` Unsupported intent without context
- Input: request requiring block selection when none exists.
- Expected: `needs_clarification`, no mutation.

## D. Auto-Repair Paths

1. `D1` Repairable deterministic mismatch
- Input: plan with one deterministic schema mismatch eligible for repair.
- Expected: one repair attempt, successful apply.

2. `D2` Non-repairable mismatch
- Input: plan requiring semantic rewrite to pass validation.
- Expected: no semantic repair; `validation_error` or `needs_clarification`.

3. `D3` Repair attempt fails
- Input: eligible repair attempted but still invalid after revalidation.
- Expected: stop after one retry; no additional retries.

## E. Safety Invariants

For all rejected cases:

1. No content mutation is persisted.
2. `previewVersion` does not increment.
3. Response includes actionable error details for UI display.

## Implementation Notes

1. This v1 spec maps to current flat `PageDoc.blocks[]`.
2. Section-aware composition constraints are intentionally deferred to a future spec revision.
3. Future versions can extend taxonomy with policy/a11y/SEO categories without breaking v1 structural contracts.
