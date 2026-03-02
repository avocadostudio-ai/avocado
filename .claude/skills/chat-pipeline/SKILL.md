# Chat & AI Planning Pipeline

Activate this skill when working on chat, AI planning, SSE streaming, intent detection, operations, or the planner system.

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
