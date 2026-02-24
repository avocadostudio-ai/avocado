# AI Site Editor PoC

Local monorepo PoC for chat-driven website editing with instant preview updates.

## Apps

- `apps/site` Next.js website renderer on `http://localhost:3000`
- `apps/editor` Vite editor UI on `http://localhost:4100`
- `apps/orchestrator` Fastify API on `http://localhost:4200`
- `packages/shared` Shared types, schemas, registry, and edit-plan validation

## Run

1. Install pnpm and dependencies:
   - `pnpm install`
2. Copy env template if needed:
   - `cp .env.example .env`
3. Start all apps:
   - `pnpm dev`

## Key endpoints

- `GET /draft/pages?session=dev&slug=/`
- `POST /chat`
- `POST /history/undo`
- `POST /history/redo`

## Notes

- If `OPENAI_API_KEY` is missing, `/chat` uses deterministic demo planning.
- Site preview refresh is triggered by editor `postMessage` with `draftUpdated`.
