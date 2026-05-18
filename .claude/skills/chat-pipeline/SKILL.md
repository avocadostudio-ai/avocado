---
name: chat-pipeline
description: Chat pipeline, AI planning, SSE streaming, intent detection, and planner system reference. Use when working on chat flow, streaming, intent detection, or the planning pipeline.
---

# Chat & AI Planning Pipeline

## Pipeline Overview

```
User message → /chat or /chat/stream
  → runChatPipeline()
    → short-circuit checks (info/advice/block-catalog queries)
    → deterministic create-page shortcut (if applicable)
    → demo planner (if no OPENAI_API_KEY)
    → OpenAI planner (with up to 3 retries)
    → respondFromPlan()
      → normalize plan copy for UI
      → withUnsplashHeroImage (image resolution)
      → apply operations atomically
      → SSE progress events
```

## Key Files

- `apps/orchestrator/src/routes/chat.ts` — route wrappers, SSE setup
- `apps/orchestrator/src/chat/chat-pipeline.ts` — core pipeline logic
- `apps/orchestrator/src/chat/planner.ts` — OpenAI integration
- `apps/orchestrator/src/chat/variation-pipeline.ts` — block variation generation
- `apps/orchestrator/src/nlp/intent-detection.ts` — intent predicates, ChatRequestBody, ChatResult

## Route Endpoints

**`POST /chat`** — synchronous chat. Creates `ChatPipelineContext`, delegates to `runChatPipeline`.

**`GET /chat/stream`** — SSE streaming. Sets headers (`text/event-stream`), writes `retry: 60000`, passes three callbacks:
- `onPlanningToken(text)` — raw LLM token
- `onOpApplied(index, total, op, previewVersion, focusBlockId)` — per-op progress
- `onStatusUpdate(message)` — status label

**`POST /chat/variations`** — generates N variants of a block's props.

## SSE Event Types

| Event | Fields | When |
|---|---|---|
| `{ type: "status", message }` | status label | Pipeline stage changes |
| `{ type: "token", text }` | raw LLM token | During OpenAI streaming |
| `{ type: "op_applied", index, total, op, previewVersion, focusBlockId }` | operation progress | Each op applied |
| `{ type: "final", result }` | full `ChatResult` | Terminal success |
| `{ type: "error", result, code }` | error info | Terminal failure |

## runChatPipeline Flow

1. **Validate request.** Handle `discard_pending_plan` and `apply_pending_plan` execution modes.
2. **Pending context.** Prepend pending-clarification context via `plannerMessageWithPendingContext`.
3. **Resolve slug.** `resolveEffectiveSlug` — may differ from `requestedSlug` if `activeBlockId` is on another page.
4. **Short-circuits:**
   - `isInfoQuery` → deterministic info response (no AI)
   - `isAdviceQuery` → deterministic advice response (no AI)
5. **Build context pack** via `plannerContextPack(...)` (recent edits, selected block, references).
6. **`respondFromPlan(plan, source, applyMode)`** inner function:
   - Normalizes plan copy for UI (`normalizePlanCopyForUi`)
   - Runs `withUnsplashHeroImage` — intercepts Hero `imageUrl` updates: AI-generated (DALL-E) or Unsplash fallback
   - `needs_clarification` → stores in `pendingClarificationBySession`, returns suggestions
   - `plan_only` mode → stores in `pendingApprovalPlanBySession`, returns `plan_ready` status
   - `apply_now` → validates atomically, replays ops with SSE events, saves undo, bumps version, persists state
7. **Deterministic shortcut:** `deterministicCreatePagePlan` for simple "create a page" requests.
8. **Demo mode** (no `OPENAI_API_KEY`): `demoPlanFromMessage` → `respondFromPlan`.
9. **OpenAI mode:** `generatePlanWithOpenAI` with up to 3 retries. On failure, attempts deterministic repair via `buildDeterministicRepairFeedback` if eligible.

## OpenAI Integration (`planner.ts`)

- `generatePlanWithOpenAI(args)` — two-part prompt (system + JSON context pack) → `chat.completions.create`. Streams tokens via `onToken`. Returns validated `EditPlan`.
- `parseIntentWithOpenAI(args)` — lighter intent classification call.
- `openAIChatOptionsForModel(model)` — omits `temperature` for o-series and gpt-5 models.

## Intent Detection (`intent-detection.ts`)

Defines `ChatRequestBody` and `ChatResult` types. Predicates:
- `isInfoQuery(message)` — questions about the system
- `isAdviceQuery(message)` — requests for advice/suggestions
- `isBlockCatalogQuery(message)` — asks about available block types

These short-circuit the pipeline to return deterministic responses without calling AI.

## Variation Pipeline (`variation-pipeline.ts`)

`runVariationPipeline` — generates N (default 3) variants of a block's props via OpenAI. Optionally resolves Unsplash images for Hero blocks.

## Image Resolution

`withUnsplashHeroImage(args)` — post-plan hook:
- Intercepts Hero blocks with `imageUrl` in their update patch
- If OpenAI API present: calls DALL-E for image generation
- Otherwise: falls back to Unsplash search
- Rewrites the op's patch in place with the resolved URL

## ChatResult Shape

```typescript
type ChatResult = {
  status: "applied" | "plan_ready" | "clarification_needed" | "info" | "advice" | "error"
  plan?: EditPlan
  previewVersion?: number
  focusBlockId?: string
  suggestions?: string[]
  message?: string
  traceId?: string
  promptHash?: string
}
```

## Model Tiers

Editor sends `modelKey` in request body. Orchestrator maps via `OPENAI_MODEL_*` env vars:
- `fast` — fastest model
- `balanced` — default
- `reasoning` — deeper thinking
- `codex` — code-focused

## Environment Flags

Responsiveness optimizations — all default **on** (`1`). Set to `0` to disable.

| Flag | Default | Description |
|------|---------|-------------|
| `CHAT_PARALLEL_PLANNER` | `1` | Launch intent router and full LLM planner concurrently. Router gets a head-start; if it succeeds the full planner is aborted. Saves 500-1000ms when the router misses. |
| `CHAT_ROUTER_HEAD_START_MS` | `200` | Milliseconds the fast intent router runs before the full planner starts (0-1000). Higher = more API cost savings when router succeeds; lower = faster fallback. |
| `CHAT_DEFER_IMAGE_RESOLUTION` | `1` | Apply text/structural ops immediately, then resolve images (Unsplash/DALL-E) in the background. Images patch in via follow-up SSE events. Avoids 1-15s blocking. |
| `CHAT_STREAMED_OP_APPLY` | `1` | Validate and apply each op as it streams from the LLM, instead of waiting for the full plan. User sees changes at ~800ms intervals. Rolls back on failure. |
| `CHAT_LLM_INTENT_ROUTER` | `1` | Enable the fast-model intent router before the full planner. |
| `CHAT_INCREMENTAL_APPLY` | `1` | Apply ops one-by-one with preview version bumps (progressive UI updates). |
| `CHAT_INCREMENTAL_PLAN_STREAM` | `1` | Stream op candidates to the editor as they parse from the LLM JSON. |
| `CHAT_STREAM_APPLY_MIN_STEP_MS` | `260` | Minimum ms between progressive op-applied events (paces UI animation). |
| `CHAT_AUTO_REASONING` | `1` | Auto-enable Anthropic extended thinking (`thinking: { type: "enabled" }`) on complex/ambiguous prompts. Signals: multi-step, clarification follow-ups, structural verbs (restructure/rewrite tone/…), long prompts with conditional language. Only activates for the `anthropic` planner — OpenAI/Gemini ignore it. Emits `thinking_start` / `thinking_token` / `thinking_end` SSE events so the editor can render a collapsed "Thinking…" block. |
| `CHAT_AUTO_REASONING_BUDGET` | `2048` | `budget_tokens` passed to Anthropic when extended thinking is enabled. Must be >= 1024. |

Other chat flags (default **off**):

| Flag | Default | Description |
|------|---------|-------------|
| `CHAT_STRICT_PRIMARY_OP_MODE` | `0` | Force single-op plans (one operation per message). |
| `CHAT_STRICT_JSON_RESPONSE` | `0` | Use OpenAI structured outputs for strict JSON schema validation. |
| `CHAT_ADAPTIVE_SCHEMA_CONTEXT` | `0` | Dynamically select which block contracts to include based on message content. |
| `CHAT_SCHEMA_BUDGET_BYTES` | `9000` | Max bytes for adaptive schema context payload. |
| `CHAT_COMPACT_CONTEXT_EXPERIMENT` | `0` | Compact the planner context pack to reduce token usage. |
| `CHAT_MINIMAL_CONTEXT_EXPERIMENT` | `0` | Strip context pack to bare minimum for simple edits. |
