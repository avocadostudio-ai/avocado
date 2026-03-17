# Runtime Understanding and Instant Live DOM Vision

## Current State
- Runtime understanding is primarily contract-driven:
  - manifest provides component and field schema context,
  - page model (`PageDoc`) is the source for planning and operation application.
- Preview-side updates use patch messaging and acknowledgements, but visual reconciliation still relies heavily on refresh-driven updates.
- Structural safety is strong at operation layer, while runtime "site understanding" depends on explicit wrappers and editable markers.

## Target State
Deliver a hybrid runtime editing system that is both:
1. deterministic and schema-safe (contract mode), and
2. fast and resilient to integration variance (inferred mode + instant apply pipeline).

The target user experience:
- AI understands editable structure even when instrumentation depth varies.
- Most accepted operations appear instantly in preview with minimal perceived latency.
- Source-of-truth reconciliation remains reliable under version drift or transport failures.

## Vision: Dual Understanding Modes
### Contract Mode (authoritative)
- Input model comes from manifest + page model contract.
- Highest confidence mode for planning and validation.
- Required for full structural editing guarantees.

### Inferred Mode (fallback and augmentation)
- Build a runtime inference layer from DOM structure, editable markers, semantic cues, and component heuristics.
- Use confidence scoring:
  - high confidence: allow scoped non-destructive edits,
  - low confidence: require clarification or degrade gracefully.
- Never let inferred mode bypass operation validation guardrails.

## Vision: Instant Apply Pipeline
### Optimistic operation-specific DOM mutator
- Apply high-frequency, low-risk operations immediately in preview (for example: text/prop updates, local reorders).
- Keep mutators op-aware and reversible per transaction.

### Versioned ack/reconcile loop
- Continue transaction IDs and version expectations as control plane.
- On ack success, retain optimistic state.
- On mismatch or reject, trigger deterministic reconcile from server state.

### Fallback on mismatch
- If version or apply mismatch occurs:
  - clear optimistic state for impacted region,
  - refresh from canonical draft snapshot,
  - preserve user focus context when possible.

## Priority Buckets
### P0: Latency instrumentation and patch transport defaulting strategy
- Add end-to-end latency metrics for submit -> op accepted -> preview reflected.
- Define and ship default patch transport behavior by integration profile.
- Establish baseline UX targets (for example, perceived update time and mismatch rate budgets).

### P1: Op-level DOM patcher for high-frequency operations
- Implement a scoped optimistic mutator set for common operations.
- Gate by operation type and confidence so unsupported operations use existing safe fallback.
- Add transaction-level rollback hooks for rejected or stale patches.

### P2: Inferred runtime model builder and confidence scoring
- Add runtime inference pipeline producing a provisional editable model.
- Add confidence thresholds and policy mapping to allowed edit classes.
- Integrate inferred signals into planner context only when confidence and guardrails allow.

## Guardrails
- Canonical source of truth remains orchestrator draft state plus validated operations.
- No direct DOM-only mutations may be treated as persisted changes without operation acceptance.
- Inferred mode can expand usability, but cannot weaken schema or safety enforcement.
- Any confidence drop, version drift, or apply error must fail safe with explicit fallback.

## Success Criteria
- Median perceived update latency decreases for common edits without increasing correctness regressions.
- Patch mismatch and rollback rates remain within defined reliability thresholds.
- Structural edit safety remains unchanged relative to current guardrail baseline.
- Inferred mode increases successful edit assistance on partially instrumented pages while maintaining safe degradation behavior.
