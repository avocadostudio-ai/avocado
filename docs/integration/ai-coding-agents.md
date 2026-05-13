# Guide for AI Coding Agents

Instructions for dev teams using LLM-based coding tools (Claude Code, Codex, Cursor, Copilot, etc.) to work in this codebase. Share this with your AI agent or paste it into your agent's context.

## Quick reference

```bash
pnpm install              # install all dependencies
pnpm dev                  # start all 3 apps (site :3000, editor :4100, orchestrator :4200)
pnpm build                # build all workspaces
pnpm typecheck            # type-check all workspaces
pnpm test                 # run all tests
```

## Repository structure

pnpm monorepo with 3 apps and 3 packages:

| Workspace | Stack | Purpose |
|---|---|---|
| `apps/site` | Next.js 15 (App Router) | Renders pages from content JSON, editor preview target |
| `apps/editor` | Vite + React | Chat UI, model selection, iframe preview host |
| `apps/orchestrator` | Fastify | AI planning, operation engine, session state, undo/redo, publish |
| `packages/shared` | TypeScript + Zod | Schemas (`PageDoc`, `BlockInstance`, `Operation`, `EditPlan`), block registry |
| `packages/blocks` | React | Block renderer components (Hero, FeatureGrid, CTA, etc.) |
| `packages/site-sdk` | TypeScript + React | Adopter-facing SDK: route handlers, draft context, editor overlay |
| `packages/preview-adapter` | TypeScript + React | PostMessage bridge (`site-editor/v1`), CSS overlay system |

## Code conventions

### TypeScript

- **Target**: ES2022, **Module**: ESNext, **Resolution**: Bundler
- **Strict mode** enabled everywhere
- `.ts` extensions in imports are allowed (`allowImportingTsExtensions: true`)
- Orchestrator imports use `.js` extensions (ESM convention): `import { foo } from "./bar.js"`
- Cross-package imports use workspace aliases: `@avocadostudio-ai/shared`, `@ai-site-editor/site-sdk`, etc.
- No linter or formatter configured — follow existing code style

### Tests

- **Runner**: Node's built-in `node:test` with `tsx`
- **Files**: `*.test.ts` colocated alongside source (same directory)
- **Assertions**: `node:assert/strict`
- **Run**: `pnpm test` or `pnpm --filter @ai-site-editor/orchestrator test`
- **Env**: Tests run with `NODE_ENV=test`
- Tests are primarily in `apps/orchestrator` — other packages rely on typecheck

### File naming

- Source files: `kebab-case.ts` (e.g. `draft-fetch.ts`, `editor-cors.ts`)
- React components: `kebab-case.tsx` (e.g. `block-error-boundary.tsx`)
- Route files: `kebab-case.ts` exporting `async function fooRoutes(app: FastifyInstance)`

## Key patterns

### Block system

Blocks are defined in `packages/shared/src/blocks.ts` using `registerBlock()`:

```ts
registerBlock("Hero", {
  schema: z.object({ heading: z.string(), subheading: z.string().optional(), ... }),
  meta: { displayName: "Hero", category: "hero", fields: { heading: f.text("Heading"), ... } }
})
```

Block renderers live in `packages/blocks/src/` — one file per block type. To add a new block, register it in shared and add a renderer in blocks.

### Orchestrator routes

Routes are Fastify plugins in `apps/orchestrator/src/routes/`:

```ts
export async function myRoutes(app: FastifyInstance) {
  app.get("/my-endpoint", async (req, reply) => { ... })
}
```

### Site SDK handler factories

API routes in `apps/site` use one-liner SDK factories:

```ts
import { createDraftEnableHandler } from "@ai-site-editor/site-sdk"
export const GET = createDraftEnableHandler()
```

### PostMessage protocol

Editor ↔ site communication uses `site-editor/v1` protocol via `packages/preview-adapter`. Messages are typed and validated.

## Common tasks

### Add a new block type

1. Define schema + meta in `packages/shared/src/blocks.ts`
2. Add renderer in `packages/blocks/src/<BlockName>.tsx`
3. Export renderer from `packages/blocks/src/index.ts`
4. Run `pnpm typecheck` to verify

### Add an orchestrator API endpoint

1. Create or edit a route file in `apps/orchestrator/src/routes/`
2. Register in `apps/orchestrator/src/app.ts` if new file
3. Add test as `*.test.ts` alongside
4. Run `pnpm test`

### Modify site SDK

1. Edit files in `packages/site-sdk/src/`
2. Update exports in `packages/site-sdk/src/index.ts` if adding new exports
3. Run `pnpm typecheck`

### Modify the editor UI

1. Edit files in `apps/editor/src/`
2. Vite hot-reloads — check `http://localhost:4100`

## Environment setup

Copy `.env.example` to `.env`. Key variables:

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | No | OpenAI API key for AI planning (omit for demo mode) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key for AI planning (omit for demo mode) |
| `DRAFT_MODE_SECRET` | For editor | Shared secret for draft mode activation |
| `ORCHESTRATOR_URL` | No | Orchestrator API URL (defaults to `http://localhost:4200`) |

If both API keys are omitted, the planner uses deterministic demo mode (no LLM calls).

## Architecture deep dives

For more detailed architecture docs, see `.claude/skills/` which contains:

| Skill | Covers |
|---|---|
| `architecture` | Full monorepo architecture and data flow |
| `block-system` | Block registry, schemas, renderers, and metadata |
| `chat-pipeline` | Chat → planner → operations → preview pipeline |
| `preview-editor` | PostMessage bridge, iframe overlay, selection system |
| `add-block` | End-to-end guide for adding a new block type |
| `fix-ops` | Debugging and fixing operation execution |

## Do's and don'ts

**Do:**
- Run `pnpm typecheck` after any change across packages
- Run `pnpm test` after changing orchestrator code
- Keep test files colocated with source
- Use workspace aliases for cross-package imports
- Follow existing patterns in the file you're editing

**Don't:**
- Don't add new dependencies without checking if the functionality exists in shared packages
- Don't create `pages/` directory files — this is App Router only
- Don't modify `packages/shared/src/blocks.ts` schemas without checking downstream renderers in `packages/blocks`
- Don't hardcode orchestrator URLs — use `getOrchestratorUrl()` from site-sdk
- Don't skip `.js` extensions in orchestrator imports (ESM requires them)
