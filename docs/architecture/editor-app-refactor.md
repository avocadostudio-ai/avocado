# Editor App.tsx Refactoring

## Overview

Refactored `apps/editor/src/App.tsx` from a 2,341-line monolithic component into focused modules. The original file contained all editor state, site-list management, chat submission, variation modals, preview communication, publish logic, and all JSX in a single export.

## Before / After

| Metric | Before | After |
|--------|--------|-------|
| `App.tsx` lines | 2,341 | 627 |
| Files | 1 | 11 |
| Hooks extracted | 0 | 5 |
| Components extracted | 0 | 3 |

## Files Created

### Types & Utilities

| File | Lines | Contents |
|------|-------|----------|
| `lib/editor-types.ts` | 154 | All 11+ type definitions: `ModelKey`, `PlannerSource`, `ChatEntry`, `AssistantResponse`, `VariationOption`, `SiteConfig`, `RestoreSnapshot`, `PublishStatus`, etc. |
| `lib/editor-utils.ts` | 275 | Constants (`SITE_LIST_STORAGE_KEY`, `AUTO_SITE_PRESETS`, `previewPresetWidths`, env-derived `siteOrigin`/`orchestrator`/`publishToken`) and 15+ pure functions (`sanitizeSiteId`, `resolveEditorSiteId`, `loadSiteListFromStorage`, `isVariationRequest`, `isComplexTaskRequest`, `splitAiInsightChanges`, etc.) |

### Components

| File | Lines | Contents |
|------|-------|----------|
| `components/VariationScaledPreview.tsx` | 53 | Scaled block preview for variation picker. Uses `ResizeObserver`, `SharedBlockRenderer`. Zero coupling to App state. |
| `components/SiteTileDesktopPreview.tsx` | 37 | Scaled iframe preview for site tiles. Self-contained with its own `ResizeObserver`. |
| `components/SitesPage.tsx` | 198 | Full sites page: site grid, add-site modal, config modal, restore-snapshot modal. Receives `UseSiteListReturn` as props. |

### Hooks

| File | Lines | Contents |
|------|-------|----------|
| `hooks/useSiteList.ts` | 187 | Site list CRUD state, localStorage persistence, restore-snapshot flow, config editing. Returns `activeSiteConfig` and all callbacks. |
| `hooks/usePreviewBridge.ts` | 112 | Iframe `postMessage` communication: `postToSite`, `postPatchToSite`, message listener for `blockClicked`/`routeChanged`/`blockReordered`/`blockDeleteRequested`/`inlineTextCommitted`. |
| `hooks/useChatEngine.ts` | 767 | Chat submission (HTTP + SSE streaming), variation generation/application, plan approval/stop, undo history, block reorder/delete/inline-edit via `/ops`. Owns `chatLog`, `isLoading`, `streamStatus`, `pendingPlanId`, `variationModal`. |
| `hooks/usePublish.ts` | 116 | Publish trigger, status polling, derived `publishInProgress`/`publishTerminal` states. Accepts `pushMessage` callback for chat log integration. |
| `hooks/useMediaInput.ts` | 45 | `transcribeAudio` and `interpretPastedImage` — pure async functions calling orchestrator endpoints. |

## Architecture Decisions

1. **Separate `EditorPage` component**: The `isSitesPage` early-return now sits in `App()` above all hooks. `EditorPage` is a separate component so hooks are always called unconditionally — fixing the original conditional-hooks pattern.

2. **Callback-based integration**: `usePublish` accepts a `pushMessage` callback (provided by `useChatEngine.pushAssistantFromResult`) so publish messages appear in the shared chat log without duplicating state.

3. **Ref-based stale closure prevention**: `useChatEngine` uses `slugRef` and `routeOptionsRef` to avoid stale closures in async functions like `submitChatStream` and `applyChatResult`.

4. **JSX stays in EditorPage**: The chat thread rendering, variation modal, and settings popover JSX (~350 lines) remain in `EditorPage` since they're tightly coupled to the composed hook return values.

## Verification

- `pnpm typecheck` — 0 errors across all 6 workspaces
- `pnpm build` — all workspaces build successfully
- `pnpm test` — 94 tests pass, 0 failures
- Runtime behavior is identical (no logic changes, pure extraction)
