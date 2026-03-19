# Chunked Plan Execution With Continue

## Problem
Complex plans are currently approved/applied as one unit, which makes long requests hard to control and recover.

## Proposal
Implement resumable step-based execution where users run one step at a time via **Continue to next step**.

## Step Chunking
- Multi-page plans: one step per page.
- Cross-page structure ops (like page reordering): final structure step.
- Single-page large plans: split by block (one step per blockId); page-level ops go to a final page-level step.

## Execution Behavior
- `plan_only` stores `steps[]`, `nextStepIndex`, and `totalSteps`.
- `apply_pending_plan` applies exactly one step.
- If more steps remain, return `plan_ready` again with next-step metadata.
- Last step returns `applied` and clears pending plan.
- On failure, keep completed steps and pause queue.

## UX
- Primary action:
  - `Start Step 1 of N`
  - then `Continue to Step X of N`
- Secondary action: `Stop`.
- Show step progress in chat (e.g. Step 2/5 ready/applied).

## API/Type Additions
- Response: `planStepIndex`, `planTotalSteps`, `planStepTitle`, `planStepSummary` (optional).
- Pending plan state: `steps`, `nextStepIndex`, `totalSteps`.

## Defaults
- Explicit continue only (no auto-advance).
- No global rollback across completed steps.
- Keep single-step behavior for non-complex plans.
