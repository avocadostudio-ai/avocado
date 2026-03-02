# Monorepo Architecture

Activate this skill when working on cross-app features, debugging data flow between apps, or understanding how the system connects.

## System Overview

```
Editor UI (4100) ←→ Orchestrator API (4200) ←→ Site Renderer (3000)
```

pnpm monorepo: three apps + two packages. All communication is HTTP + postMessage.

## apps/orchestrator (Fastify backend)

**Entry:** `apps/orchestrator/src/index.ts` — registers CORS, multipart, routes; on startup calls `loadStateFromDisk`, `ensurePresetRestoreSessions`.

**All state is in-memory** (`apps/orchestrator/src/state/session-state.ts`):
- `publishedPages: Map<string, PageDoc>` — immutable baseline from `demoPublishedPages()`
- `draftPages: Map<string, Map<string, PageDoc>>` — keyed by scoped session, then slug
- `historyUndo / historyRedo: Map<string, Map<string, PageDoc[]>>` — per-session per-slug snapshot stacks
- `versions: Map<string, number>` — monotonic preview version counter per session
- `recentEdits`, `chatHistoryBySession`, `pendingClarificationBySession`, `pendingApprovalPlanBySession`, `publishStatusBySession`

**Session key scoping:** `scopedSessionKey(session, siteId)` — returns `"session"` for `avocado-stories`, `"siteId::session"` for others.

**Persistence:** Debounced 80ms write to `.data/orchestrator-state.json` with rolling backups (40 max, 2-min interval). Backup force-created on startup.

**Route plugins:**

| Plugin | File | Key endpoints |
|---|---|---|
| `contentRoutes` | `routes/content.ts` | `GET /published/pages`, `GET /draft/pages`, `GET /draft/slugs`, `GET /generated-images/:fileName`, `GET /publish/content` |
| `publishingRoutes` | `routes/publishing.ts` | `POST /publish`, `GET /publish/status`, `GET /restore/snapshots`, `POST /restore/snapshot` |
| `chatRoutes` | `routes/chat.ts` | `POST /chat`, `POST /chat/variations`, `GET /chat/stream` (SSE) |
| `opsRoutes` | `routes/ops.ts` | `POST /ops` (direct operation apply, bypasses AI) |
| `mediaRoutes` | `routes/media.ts` | `POST /audio/transcribe`, `POST /image/interpret` |
| `historyRoutes` | `routes/history.ts` | `POST /history/undo`, `POST /history/redo` |
| inline | `index.ts` | `GET /health`, `GET /status/planner`, `GET /telemetry/chat` |

## apps/editor (Vite + React 19)

**Entry:** `apps/editor/src/App.tsx` — `EditorPage` manages all state via three hooks:
- `usePreviewBridge(slug, callbacks)` — iframe communication
- `useChatEngine(config)` — chat/AI operations, undo/redo
- `usePublish(session, siteId)` — deployment

**Preview iframe URL:** `{siteOrigin}{slug}?__editor=1&session=...&siteId=...&siteName=...&editorOrigin=...`

**Model selection:** `modelKey` state (`"fast" | "balanced" | "reasoning" | "codex"`) sent in every `/chat` request.

**Key hooks:**
- `usePreviewBridge.ts` — owns `iframeRef`, listens for `site-editor/v1` postMessages, sends `draftUpdated`/`highlightBlock`/`applyPatch` to iframe
- `useChatEngine.ts` — manages `chatLog`, calls `/chat/stream` or `/chat`, handles undo/redo via `/history/undo|redo`, plan approval flows

## apps/site (Next.js 15)

**Catch-all page:** `apps/site/app/[[...slug]]/page.tsx` — `force-dynamic`, no cache. Detects editor mode via `?__editor=1`.

**Data fetching:** `apps/site/lib/content-api.ts`
- `fetchDraftPage(slug, session, siteId)` — `GET /draft/pages` from orchestrator; falls back to `published-content.json`
- `fetchDraftSlugs(session, siteId)` — `GET /draft/slugs`; falls back to static list

**Block rendering:** `apps/site/components/block-renderer.tsx` — wraps `SharedBlockRenderer` from `@ai-site-editor/blocks` in a `<div>` with `data-block-id`, `data-block-type`, `class="editor-selectable"` when in editor mode.

**Editor integration:** Mounts `PreviewBridge` from `@ai-site-editor/preview-adapter` when `editorMode=true`.

## Data flow

```
Editor UI → useChatEngine.submitChat()
  → POST /chat or GET /chat/stream (orchestrator)
    → runChatPipeline() → planner → applyOps → setPage, pushUndo, bumpVersion
    → returns ChatResult (or SSE stream)
  → applyChatResult() → postToSite("draftUpdated") or postPatchToSite(op)
    → iframe postMessage → PreviewBridge
      → site re-fetches GET /draft/pages → re-renders blocks
```

## Key files

- `apps/orchestrator/src/index.ts` — server setup
- `apps/orchestrator/src/state/session-state.ts` — all in-memory state
- `apps/orchestrator/src/routes/` — all route plugins
- `apps/editor/src/App.tsx` — editor root
- `apps/editor/src/hooks/usePreviewBridge.ts` — iframe bridge
- `apps/editor/src/hooks/useChatEngine.ts` — chat engine
- `apps/site/app/[[...slug]]/page.tsx` — catch-all page
- `apps/site/lib/content-api.ts` — data fetching
- `apps/site/components/block-renderer.tsx` — block rendering
