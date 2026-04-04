---
name: preview-editor
description: Preview bridge postMessage protocol, editor overlay, block selection UI, and CSS overlay system. Use when working on selection UI, block highlight, inline editing, or iframe communication.
---

# Preview Bridge & Editor Overlay

## PostMessage Protocol (`site-editor/v1`)

All messages use `protocol: "site-editor/v1"`. Site iframe sends to `window.parent`; editor sends to iframe's `contentWindow`.

### Outbound (site → editor)

| `type` | When | Payload |
|---|---|---|
| `blockClicked` | User clicks block or deselects | `{ slug, blockId, blockType, editablePath }` — all nullable on deselect |
| `blockReordered` | Toolbar move or Alt+Arrow | `{ slug, blockId, afterBlockId }` |
| `blockDeleteRequested` | Delete confirmed in popover | `{ slug, blockId, blockType }` |
| `routeChanged` | Next.js pathname changes | `{ slug: pathname }` |
| `patchAck` | Response to `applyPatch` | `{ txId, accepted: boolean, reason?: PatchRejectReason }` |
| `inlineTextCommitted` | User commits inline edit | `{ slug, blockId, blockType, editablePath, value }` |

### Inbound (editor → site)

| `type` | Effect |
|---|---|
| `highlightBlock` | `applyBlockFocus(blockId, false, editablePath?)` — adds `editor-highlight`, scrolls into view |
| `draftUpdated` | `smoothRefresh()` (Next.js `router.refresh()`) then re-focuses block |
| `applyPatch` | Version-checked optimistic patch; refresh + `patchAck` |
| `resetToServer` | Unconditional refresh to server version |
| `setNestedLabelsVisibility` | Toggles `editor-hide-nested-labels` class on `<html>` |

### Patch Transport (v2)

```typescript
ApplyPatchMessage = { type: "applyPatch"; txId: string; op: Operation; fromVersion: number; toVersion: number; focusBlockId?: string }
PatchAckMessage = { type: "patchAck"; txId: string; accepted: boolean; reason?: PatchRejectReason }
ResetToServerMessage = { type: "resetToServer"; toVersion: number; focusBlockId?: string }
type PatchRejectReason = "version_mismatch" | "apply_error" | "unknown_op"
```

Version tracking: `serverVersionRef` (integer). Patch rejected if `fromVersion !== serverVersionRef.current`.

## Click Handler

Registered on `document` in **capture phase** (`addEventListener("click", onClick, true)`).

1. Suppresses clicks for `suppressClickUntilRef.current` ms (anti-double-click guard)
2. If inline edit active and click outside → commits edit
3. Short-circuits for toolbar buttons (`.editor-block-delete`, `.editor-selected-delete`, `.editor-selected-move`, `.editor-delete-confirm`)
4. Walks up DOM with `closest("[data-block-id]")` to find block wrapper
5. No block found + previous selection → clears selection, emits `blockClicked` with null payload
6. Block found → prevents default (except `<summary>` for accordion toggle), stops propagation, finds closest `[data-editable-target]`, calls `applyBlockFocus`, emits `blockClicked`

## Inline Editing

**Double-click** triggers `startInlineEdit` — sets `contenteditable="true"`, adds `editor-inline-editing` class.

**Allowed paths:** regex `^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]\.[A-Za-z_][A-Za-z0-9_]*)?$`, excluding url/href/imageUrl/imageAlt. Nodes with element children are excluded.

**Keyboard:**
- `Escape` → cancel (restore original text)
- `Enter` → commit (unless `isMultiline` and `Shift+Enter` → inserts newline)
- `Alt+ArrowUp/Down` → move selected block, emit `blockReordered`

## Badge & Toolbar Injection

`ensureBlockBadges()` runs on mount + MutationObserver:
- Injects `.editor-block-badge` with `.editor-block-badge-label` into each `[data-block-id]` node
- Adds `editor-has-badge` class (suppresses CSS `::after` fallback)

`applyBlockFocus(blockId, enter, editablePath?)`:
- Removes existing `editor-highlight` classes
- Adds `editor-highlight` + `editor-flash` (260ms pulse)
- If `enter=true` (AI update): adds `editor-enter` (180ms slide-in) + `aifx-updated` (980ms sparkle)
- Creates `.editor-block-toolbar` with move-up, move-down, delete buttons
- Delete button shows confirmation popover (`.editor-delete-confirm`) with 4s auto-dismiss

## CSS Overlay System

**Custom properties** (on `.editor-selectable`):
```css
--editor-accent-rgb: 14, 116, 144;    /* teal — hover/badge */
--editor-selected-rgb: 37, 99, 235;   /* blue — selected */
--editor-focus-rgb: 217, 119, 6;      /* amber — inline editing */
```

**Z-index stack:**

| Element | z-index |
|---|---|
| `::before` overlay border | 19 |
| `::after` block-type label | 20 |
| `[data-editable-label]::after` pill | 21 |
| `.editor-block-badge` | 22 |
| Toolbar / move / delete buttons | 23 |
| `[data-editable-target]::before` path label | 24 |
| `.editor-delete-confirm` | 25 |

**State classes:**
- `.editor-selectable` — base: `position: relative`, `overflow: visible`, hover cursor
- `.editor-selectable:hover::before` — teal `2px solid` border
- `.editor-highlight::before` — blue `3px solid` border (selected)
- `.editor-highlight [data-editable-target]:hover` — `1.5px` blue box-shadow
- `.editor-inline-editing` — amber `2px` inset box-shadow + amber bg tint
- `.editor-child-highlight` — blue `1.5px` inset shadow on focused sub-field
- `.editor-hide-nested-labels` (on `<html>`) — hides all nested label pseudo-elements

**Animations:**
- `.editor-flash` → `flash` (260ms border pulse)
- `.editor-enter` → `block-enter` (180ms fade+slide+scale)
- `.aifx-updated::before` → `aifx-sparkle` (980ms sparkle)
- `.aifx-updated::after` → `aifx-wave` (920ms diagonal shimmer)
- `prefers-reduced-motion` disables `.aifx-updated` animations

## Key Files

- `packages/preview-adapter/src/preview-bridge.tsx` — PreviewBridge component, click handler, inline editing, badge/toolbar injection
- `packages/preview-adapter/src/styles.css` — all CSS overlays, animations, z-index
- `packages/preview-adapter/src/selectable.ts` — `getPreviewWrapperProps()` helper
- `apps/editor/src/hooks/usePreviewBridge.ts` — editor-side bridge (sends/receives postMessages)
