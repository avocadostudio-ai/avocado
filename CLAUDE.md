# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Documentation conventions

- **Diagrams in docs**: use Mermaid (```mermaid code blocks). The Mintlify
  docs site at `docs-site/` renders Mermaid natively. Do not use ASCII art
  for diagrams.

## Commands

```bash
# Install dependencies
pnpm install

# Start all apps in parallel
pnpm dev

# Start individual apps
pnpm dev:site         # Next.js site on :3000
pnpm dev:editor       # Vite editor UI on :4100
pnpm dev:orchestrator # Fastify API on :4200

# Build all workspaces
pnpm build

# TypeScript type checking across all workspaces
pnpm typecheck
```

## Tests

```bash
# Run all tests across monorepo
pnpm test

# Fast unit tests only (orchestrator + blocks)
pnpm test:unit

# E2E tests only (requires API keys)
pnpm test:e2e

# Orchestrator test categories
pnpm --filter @ai-site-editor/orchestrator test:unit         # ~28 pure-function tests, <2s
pnpm --filter @ai-site-editor/orchestrator test:integration   # ~4 Fastify inject tests, <3s
pnpm --filter @ai-site-editor/orchestrator test:e2e           # ~2 LLM tests, 30s+ (needs API keys)
pnpm --filter @ai-site-editor/orchestrator test:chat          # chat domain subset
pnpm --filter @ai-site-editor/orchestrator test:ops           # ops domain subset
pnpm --filter @ai-site-editor/orchestrator test:nlp           # nlp domain subset

# Run with coverage
pnpm --filter @ai-site-editor/orchestrator coverage
```

Tests use Node's built-in test runner (`node:test`) with `tsx`. Test files live alongside source as `*.test.ts`.

## Architecture

pnpm monorepo — chat-driven website editor with live preview. Three apps + two packages:

- **apps/orchestrator** (Fastify :4200) — brain: in-memory session state, AI planning, operations engine, publishing
- **apps/editor** (Vite+React :4100) — chat UI, model selection, iframe communication via postMessage
- **apps/site** (Next.js :3000) — renders `BlockInstance` pages, fetches drafts from orchestrator, editor overlay via preview-adapter
- **packages/shared** — Zod schemas (PageDoc, BlockInstance, Operation, EditPlan), block registry
- **packages/blocks** — build-in block renderers (Hero, FeatureGrid, Testimonials, FAQAccordion, CTA, Card, CardGrid, RichText)
- **packages/preview-adapter** — PreviewBridge component, postMessage protocol (`site-editor/v1`), CSS overlay system

See `.claude/skills/` for deep architecture, block system, preview-editor, and chat pipeline docs.

## Internationalization (i18n)

The editor UI supports multiple languages. English is the default; German is the first additional locale.

### How it works

1. **Editor UI** — Custom `LocaleProvider` + `useT()` hook in `apps/editor/src/i18n/`. No external library. Locale stored in `localStorage("editor-locale")`.
2. **AI responses** — Editor sends `locale` on every `/chat` and `/chat/start` request. The orchestrator injects a language instruction into LLM system prompts so `summary_for_user`, `change_log`, and `suggested_next_actions` come back in the user's language.
3. **Language switcher** — Settings (gear icon) → Language dropdown (English / Deutsch).

### Key files

| Layer | Files |
|-------|-------|
| Dictionaries | `apps/editor/src/i18n/en.ts` (source of truth), `apps/editor/src/i18n/de.ts` |
| Provider & hook | `apps/editor/src/i18n/index.tsx` — `LocaleProvider`, `useT()`, `getT()` |
| Orchestrator | `apps/orchestrator/src/chat/prompts.ts` — `localeInstruction()` injected into all prompt builders |
| Request type | `apps/orchestrator/src/nlp/intent-detection.ts` — `locale` field on `ChatRequestBody` |

### Adding a new language

1. Create `apps/editor/src/i18n/{code}.ts` (e.g. `fr.ts`) typed as `Record<LocaleKeys, string>` — TypeScript enforces all keys are present.
2. Import and register in `apps/editor/src/i18n/index.tsx`: add to `LOCALES` map and `LOCALE_LABELS`.
3. Extend the `Locale` type union: `export type Locale = "en" | "de" | "fr"`.
4. Add the language name to `LOCALE_NAMES` in `apps/orchestrator/src/chat/prompts.ts` so the LLM knows which language to respond in.
5. Run `pnpm typecheck` — any missing translation keys will be compile errors.

### Using translations in code

```tsx
// In React components:
import { useT } from "@/i18n"
const { t } = useT()
<h1>{t("header.publish")}</h1>
<p>{t("welcome.greeting", { name: "My Site" })}</p>  // {{name}} interpolation

// In pure functions (non-React), pass t as parameter:
function myHelper(t: TFunction) { return t("some.key") }
```

### What is NOT translated
- Block type names (Hero, CTA, FAQAccordion) — code identifiers
- Model/provider names (gpt-4o, Claude, OpenAI) — vendor-specific brand names
- Field AI suggestion pills — sent as prompts to the LLM, must stay in English
- Preview adapter overlay labels — deferred (separate package, needs postMessage protocol)

## Environment

Copy `.env.example` to `.env` before running. Key variables:
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — at least one required for AI planning; omit both for demo mode
- `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` — override model names per tier (fast/balanced/reasoning/codex)
- `ORCHESTRATOR_URL` — defaults to `http://localhost:4200`

## Demo mode (limited public playground)

Setting `DEMO_MODE=1` on the orchestrator turns the deployment into a locked-down "try before you sign up" playground that runs on your shared API key. The gate is **server-enforced** (client-sent capability flags can't bypass it) and lives in `apps/orchestrator/src/demo-mode.ts`.

**What demo mode does:**
- Only allow-listed ops are permitted (default: `update_props` on `Hero` blocks). Everything else returns a friendly `needs_clarification` with example prompts. Enforcement sits inside `applyOpsAtomically` so both `/chat` and direct `/ops` calls are covered.
- Each visitor gets an isolated ephemeral session keyed by `demo-<sha1(ip).slice(0,10)>`, seeded from `demoPublishedPages()`. No persistence — state resets on server restart.
- `/agent/*`, `/sites-agent/*`, and `/jira/*` return `403` (they'd bypass the op gate).
- Image generation (DALL-E / Unsplash) is short-circuited inside `detectImageOps` so no external image APIs get hit.
- Per-IP hourly rate limit on `/chat*` and `/ops` (default 20/hr, header `retry-after` + HTTP 429).
- `/status/planner` returns `plannerSource: "demo"` so the editor shows its demo badge.

**Orchestrator env vars (Render):**
```
DEMO_MODE=1
DEMO_ALLOWED_OPS=update_props                  # comma list
DEMO_ALLOWED_BLOCK_TYPES=Hero                  # comma list
DEMO_RATE_LIMIT_PER_IP_PER_HOUR=20
DEMO_DISABLE_IMAGE_GEN=1
OPENAI_API_KEY=<your shared key>               # or ANTHROPIC_API_KEY
ORCHESTRATOR_CORS_ORIGINS=https://demo-editor.vercel.app,https://demo-site.vercel.app
ORCHESTRATOR_STATE_FILE=                       # leave empty — state is ephemeral
```

**Editor env vars (Vercel):** (build-time; needs separate Vercel project from prod editor)
```
VITE_DEMO_MODE=1
VITE_ORCHESTRATOR_URL=https://<your-demo-orchestrator>.onrender.com
VITE_SITE_ORIGIN=https://demo-site.vercel.app
VITE_LOCK_SITE_ID=1
```

**Site env vars (Vercel):** (server-side; also needs a separate project)
```
ORCHESTRATOR_URL=https://<your-demo-orchestrator>.onrender.com
NEXT_PUBLIC_EDITOR_ORIGIN=https://demo-editor.vercel.app
DRAFT_DEFAULT_SESSION=dev
NEXT_PUBLIC_DEFAULT_SITE_ID=avocado-stories
NEXT_PUBLIC_ENABLE_EDITOR=1
```

The orchestrator middleware rewrites `body.session` / `body.siteId` on every demo request, so clients do NOT need to know their demo session key — they just send `session=dev` (or anything) and the middleware swaps it for `demo-<hash(ip)>` + `siteId=avocado-stories` before handlers run.

To widen the demo allow-list (e.g. to include CTA edits) without redeploying code, set `DEMO_ALLOWED_BLOCK_TYPES=Hero,CTA`. To allow additional op types, set `DEMO_ALLOWED_OPS=update_props,update_item`. Tests in `apps/orchestrator/src/demo-mode.test.ts` cover the split-allow logic.

### Chat Pipeline Flags

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

Other chat flags (default **off**):

| Flag | Default | Description |
|------|---------|-------------|
| `CHAT_STRICT_PRIMARY_OP_MODE` | `0` | Force single-op plans (one operation per message). |
| `CHAT_STRICT_JSON_RESPONSE` | `0` | Use OpenAI structured outputs for strict JSON schema validation. |
| `CHAT_ADAPTIVE_SCHEMA_CONTEXT` | `0` | Dynamically select which block contracts to include based on message content. |
| `CHAT_SCHEMA_BUDGET_BYTES` | `9000` | Max bytes for adaptive schema context payload. |
| `CHAT_COMPACT_CONTEXT_EXPERIMENT` | `0` | Compact the planner context pack to reduce token usage. |
| `CHAT_MINIMAL_CONTEXT_EXPERIMENT` | `0` | Strip context pack to bare minimum for simple edits. |
