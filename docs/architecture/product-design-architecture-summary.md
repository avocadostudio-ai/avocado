# AI Site Editor: Product Design and Architecture Summary

_Last updated: 2026-03-03_

## 1. Product Design Summary

### Product goal
This project is a chat-driven website editor where non-technical users edit site content in natural language and immediately see results in live preview.

### Core UX model
- Desktop split experience (current implementation):
  - Site preview (left): live rendered page with block selection and inline edit hooks.
  - Editor app (right): chat, route/site controls, model/provider selection, plan actions, publish actions.
- Mobile/narrow widths collapse to a single-column stacked layout.
- The preview is the main editing canvas; chat is the control interface.
- Changes are applied as structured operations, not freeform code edits.

### Primary user flows
- Ask for content/layout updates in chat (`"make hero shorter"`, `"add FAQ below features"`).
- Click a section in preview to set editing context for more precise follow-up edits.
- Use undo/redo and plan approval lifecycle (`plan_only`, `apply_pending_plan`, `discard_pending_plan`).
- Publish draft content to committed site content through orchestrator publish flow.

## 2. Monorepo Architecture

### Workspace structure
- `apps/site` (Next.js): renders pages from content JSON and enables editor harness mode.
- `apps/editor` (Vite + React): chat UI + orchestration client + iframe integration.
- `apps/orchestrator` (Fastify): planning, validation, operation apply engine, state, publish, telemetry.
- `packages/shared`: shared schemas/types/contracts (`PageDoc`, `Operation`, `EditPlan`, block registry).
- `packages/blocks`: shared block renderer components.
- `packages/preview-adapter`: preview overlay, selection, and postMessage bridge logic.

### Runtime topology (local default)
- Site: `:3000`
- Editor: `:4100`
- Orchestrator: `:4200`

### High-level data/control flow
1. Editor sends user message + context to orchestrator (`/chat` or `/chat/stream`).
2. Orchestrator resolves intent/plan (deterministic and/or LLM), validates, applies ops atomically.
3. Orchestrator returns status, summary, change list, affected slugs, `previewVersion`, optional `focusBlockId`.
4. Editor notifies site iframe (`draftUpdated` / patch events).
5. Site refreshes draft content and re-renders blocks.

## 3. Content and Domain Model

### Content model
- `PageDoc`: page-level document (`slug`, `title`, `meta`, `blocks[]`).
- `BlockInstance`: typed block (`id`, `type`, `props`).
- Block types are registry-driven in `packages/shared` with Zod validation and field metadata.

### Operation model (structured edits)
The orchestrator applies a validated, typed operation contract (`operationSchema`) shared across editor/site/backend. Current operation families are:
- Page ops: `create_page`, `rename_page`, `remove_page`, `move_page`, `duplicate_page`, `update_page_meta`
- Block ops: `add_block`, `update_props`, `remove_block`, `move_block`, `duplicate_block`
- List ops: `add_item`, `update_item`, `remove_item`, `move_item`

### State model (orchestrator)
Session-scoped in-memory maps with disk persistence:
- Draft pages, undo/redo stacks, preview versions
- Recent edits and short chat history
- Pending clarification/pending approval plan
- Publish status tracking

Session keys are scoped by `siteId::session` (with backward compatibility for legacy default site id).

## 4. Editor ↔ Site Integration

### Bridge protocol
- Versioned postMessage protocol namespace: `site-editor/v1`.
- Site -> Editor events: block clicked, route change, reorder/delete requests, inline text commit.
- Editor -> Site events: highlight block, draft updated, nested label visibility; plus patch transport messages.

### Preview adapter responsibilities
- Wrap blocks with selection metadata (`data-block-id`, `data-block-type`).
- Enable inline target mapping (`data-editable-target`) for prop-level edits.
- Manage selection highlighting, inline edit interactions, and parent-window messaging.

### Refresh model
- Current implementation supports both full refresh signaling and patch transport (`applyPatch`/`patchAck`/`resetToServer`).
- Site route is force-dynamic/no-store for reliable preview freshness in editor mode.

## 5. How LLM Is Used

### Provider/model strategy
- Supported providers: OpenAI and Anthropic.
- Editor sends provider + abstract `modelKey` (`fast`, `balanced`, `reasoning`, `codex`).
- Orchestrator resolves concrete model IDs from env (`OPENAI_MODEL_*`, `ANTHROPIC_MODEL_*`).
- If no provider API key is available, orchestrator uses deterministic demo planning.

### LLM responsibilities
1. Intent extraction (where needed): classify user request shape and targets.
2. Plan generation: output strict JSON `EditPlan` with human summary + `ops[]`.
3. Optional streaming: planning tokens can stream via SSE before final result.

### Guardrails around LLM output
- Strong system prompts constrain operation names, targeting rules, and output format.
- JSON extraction + normalization (`plan-normalizer`) repairs common malformed model outputs.
- Full schema validation via Zod (`editPlanSchema`, `operationSchema`).
- Block prop validation against per-block contracts before persistence.
- Atomic apply engine rejects invalid/no-op/inconsistent plans and can trigger deterministic repair paths.

### Hybrid deterministic + LLM pipeline
- Fast deterministic intent handling is used for high-confidence patterns.
- LLM path is used for ambiguous/complex generation tasks.
- Clarification flow is explicit (`intent: needs_clarification`).
- Plan approval mode exists (`plan_only`) before applying irreversible edits.

### LLM-adjacent media features
- Image handling: hero image requests can resolve via OpenAI generation or Unsplash fallback.
- Audio/image helper endpoints support transcription and screenshot interpretation for editor UX.

## 6. Testing Strategy and Coverage

### What is currently tested
Testing is strongest in `apps/orchestrator` using Node’s built-in test runner (`node:test`) with `tsx`.

Key test suites:
- `apply-ops.test.ts`: operation correctness, error handling, and atomicity/rollback.
- `ops-engine.test.ts`: focused engine-level behavior and guardrail helpers.
- `nlp-ops.test.ts`: deterministic intent/planning and normalization matrix.
- `planner-openai.test.ts`: model output parsing, strict-mode behavior, schema rejection.
- `chat-pipeline-integration.test.ts`: end-to-end chat lifecycle, pending-plan workflow, SSE events, telemetry phases, fallback/repair paths.
- `chat-contract.test.ts`: API response shape stability for `/chat`, `/ops`, and `/chat/stream`.
- `variation-images.test.ts`, `planner-env.test.ts`: image/variation and env-specific behavior.

### How tests are run
- Workspace tests: `pnpm test`
- Orchestrator tests: `pnpm --filter @ai-site-editor/orchestrator test`
- Coverage: `pnpm --filter @ai-site-editor/orchestrator coverage`

### Testing posture summary
- Strong: domain logic, contracts, operation safety, and chat pipeline regressions.
- Weaker: full browser E2E across editor+site UX interactions (called out in backlog as a priority).

## 7. Architectural Strengths and Risks

### Strengths
- Clear separation of concerns across editor/site/orchestrator.
- Shared schema package keeps renderer and backend contract-aligned.
- Structured operation model enables safer AI editing than freeform text/code generation.
- Deterministic fallback mode improves resilience without provider keys.
- Good backend test depth around critical editing paths.

### Current risks/gaps
- Multi-editor conflict resolution and merge/publish race strategy are not finalized.
- Heavy reliance on orchestrator state lifecycle and environment correctness.
- E2E coverage for real browser interaction flows is still limited.
- Production editor exposure requires careful CORS/origin and feature gating.

## 8. Practical Takeaway

This codebase is a hybrid AI + deterministic editing system centered on **validated structured operations**, with a clean app split and a robust orchestrator test foundation. The most important implementation choices are:
- contract-first schemas in `packages/shared`,
- atomic operation application in orchestrator,
- iframe bridge for real-time preview editing,
- and guarded LLM planning instead of direct freeform mutation.
