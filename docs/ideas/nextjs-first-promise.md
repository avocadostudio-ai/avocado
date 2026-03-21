# Next.js-First Promise: Reality, Definition of Done, and Gap-Closing Roadmap

## Current Delivery Reality
- The implemented integration path is Next.js 15+ with App Router, using `@ai-site-editor/site-sdk` route factories and Draft Mode flows.
- Structural editing is manifest-driven (`/api/editor/blocks`). If manifest validation fails, the editor runs in degraded mode and blocks structural edits.
- Preview editing works by combining orchestrator draft content with site rendering wrappers (`data-block-id`, `data-editable-target`) and overlay bridge messaging.
- Publish is implemented through orchestrator modes (`git` and `deploy_hook`), with git-based publish as the current practical default for production snapshots.
- Non-Next.js integrations and provider/SPI adapters are documented as target design, not implemented runtime paths.

## Promise We Can Safely Make Now
Use this wording in product-facing materials:

> AI Site Editor is a Next.js-first embedded AI editing layer for App Router sites.  
> It provides structured, schema-guarded content and layout edits with live preview and controlled publish workflows.

What we should not claim yet:
- "Works on any framework out of the box."
- "Works across any CMS today."
- "No integration assumptions."

## Definition of Done for Next.js-First
### Target State for Next.js-First
For Next.js App Router adopters, the product should deliver a repeatable, low-risk integration that supports:
- reliable draft preview entry and exit,
- manifest-backed structural editing,
- safe operation validation and fallback behavior,
- predictable publish to production content snapshots.

### Must-Have Capabilities and Acceptance Criteria
1. Integration bootstrap
- Capability: a team can wire required endpoints and preview bridge in one pass.
- Acceptance criteria: the documented 4-route setup works without custom orchestration logic beyond content callbacks.

2. Structured edit safety
- Capability: AI and direct UI actions map to typed operations with validation guardrails.
- Acceptance criteria: malformed operations and unsupported structural edits are rejected with actionable errors.

3. Preview reliability
- Capability: users can enter draft mode, apply edits, and stay in editable preview context.
- Acceptance criteria: valid draft entry loads draft page content; invalid or unavailable draft state shows deterministic fallback states.

4. Publish reliability
- Capability: approved draft content can be promoted via configured publish mode.
- Acceptance criteria: publish response includes deterministic status and failure details; no silent success.

5. Degraded mode clarity
- Capability: when manifest or capabilities are unavailable, users receive explicit UX guidance.
- Acceptance criteria: editor blocks structural changes, explains reason, and keeps non-structural flows available.

## Known Failure Modes
1. Manifest degraded mode
- Trigger: `/api/editor/blocks` missing, invalid, or failing validation.
- Impact: structural edits disabled; editor must communicate remediation path.

2. Draft unavailable
- Trigger: orchestrator unreachable, misconfigured URL, or missing draft session data.
- Impact: preview cannot load draft content and falls back to explicit "Draft unavailable" behavior.

3. Publish assumptions mismatch
- Trigger: git branch/worktree constraints, missing deploy hook config, or environment mismatch across site/editor/orchestrator.
- Impact: publish fails after valid edits; requires transparent status and operational guidance.

4. Framework boundary mismatch
- Trigger: adopter uses Pages Router or non-Next runtime while following App Router SDK path.
- Impact: core assumptions break, producing integration dead ends despite partial setup success.

## P0/P1/P2 Priority Buckets
### P0
- Harden Next.js-first truth in messaging and docs so claims exactly match implemented behavior.
- Add explicit integration health checks in onboarding path (manifest status, draft reachability, publish prerequisites).
- Improve degraded-mode UX text and remediation links so users can self-recover.

### P1
- Reduce preview fragility by improving patch transport defaults and fallback logic clarity.
- Add stronger operational diagnostics for publish path failures (branch, auth, webhook, env mismatch categories).
- Expand Next.js-first acceptance test matrix to include real-world misconfiguration scenarios.

### P2
- Package a "production-ready Next.js profile" with opinionated defaults and diagnostics.
- Add migration aids for teams moving from basic embed to stricter governance workflows.
- Feed stable Next.js-first patterns into future framework-agnostic adapter design.

## Success Criteria
- Time-to-first-successful-edit on Next.js App Router is consistently under 30 minutes for a new adopter.
- Structural edit success rate remains high when manifest is valid, with explicit block reasons when invalid.
- Draft-mode and publish failures are detectable, categorized, and actionable without code-level debugging.
- Product messaging, docs, and actual runtime behavior remain aligned with no over-claims.
