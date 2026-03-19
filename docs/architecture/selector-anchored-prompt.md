# Selector Toggle + Hybrid Anchored Prompt Plan

Date: 2026-03-17

## Summary

Implement a Figma-Make-style chat selector flow with one-shot pick behavior and a hybrid prompt UI:

- Desktop: prompt anchored near the selected element.
- Mobile/tablet or cramped layout: fallback to the bottom composer.
- V1 scope: selector toggle plus selected-target chip (no formatting toolbar).
- Before any code edits, create a full rollback snapshot (including current dirty tree) using backup branch plus commit plus tag.

## Pre-Change Safety Snapshot

1. Capture current state (including uncommitted and untracked files):

```bash
SNAPSHOT_TS=$(date +%Y%m%d-%H%M%S)
BACKUP_BRANCH="codex/backup-selector-anchored-$SNAPSHOT_TS"
TAG_NAME="pre-selector-anchored-$SNAPSHOT_TS"

git checkout -b "$BACKUP_BRANCH"
git add -A
git commit -m "WIP snapshot before selector-anchored prompt implementation"
git tag -a "$TAG_NAME" -m "Pre-implementation snapshot for selector+anchored prompt"
```

2. Start implementation branch from current working line:

```bash
git checkout main
git checkout -b codex/selector-anchored-prompt
```

3. Revert path:

```bash
# Full rollback to pre-implementation snapshot
git checkout "$TAG_NAME"
# or
git reset --hard "$TAG_NAME"

# Return to snapshot branch state
git checkout "$BACKUP_BRANCH"
```

## Implementation Changes

### Protocol and Types

- Extend editor-to-site message types with `setSelectionMode` payload `{ enabled: boolean }`.
- Extend `blockClicked` payload to include anchor geometry for prompt positioning.
- Update message unions and parsing in editor bridge and preview bridge consistently.

### Preview Behavior (`packages/preview-adapter`)

- Add selection-mode state in preview bridge, default `false`.
- Only intercept block selection clicks when selection mode is enabled.
- Keep explicit `highlightBlock` rendering independent so selected highlight remains visible after one-shot auto-off.
- Gate hover/select affordance visuals (cursor, labels, hover outlines) by `data-editor-selection-mode`.

### Editor State and Flow (`apps/editor`)

- Add `selectionModeEnabled` state, selected-target chip state, and anchor state.
- Wire selector button in chat input to toggle mode and send `setSelectionMode`.
- On successful target pick, set active block/path, create/update target chip, auto-disable selection mode, focus prompt input, and prefer the chat tab.
- Add `Esc` handling to turn selector mode off without clearing existing selection.

### Hybrid Composer Placement

- Keep existing composer component as shared UI.
- Add anchored rendering path in `App` (position computed from iframe rect plus selected target rect).
- Fallback rules: always bottom composer on mobile/tablet, bottom composer when anchor is offscreen/clipped/insufficient, anchored composer only on desktop with valid geometry.

### UI Polish

- Selector toggle active state and aria labels.
- Target chip with remove action; removing chip clears target context only.
- Preserve current send, voice, and image flows in both anchored and bottom modes.

## Test Plan

### Type Safety and Build Checks

```bash
pnpm --filter @ai-site-editor/editor typecheck
pnpm --filter @ai-site-editor/site typecheck
pnpm --filter @ai-site-editor/preview-adapter typecheck
```

### Manual Acceptance Scenarios

- Toggle selector on, click target, selector auto-off, chip appears, prompt focused.
- Desktop: anchored prompt near target with collision-safe positioning.
- Mobile/small viewport: same flow falls back to bottom composer.
- `Esc` exits selector mode.
- Existing behaviors still work: highlight sync, inline text commit, image picker, move/add/delete controls, route switching.

### Regression Checks

- No click interception when selector mode is off.
- No layout jump or focus loss when anchored prompt falls back to bottom.

## Public Interface and Type Changes

- `site-editor/v1` message additions include a new inbound type `setSelectionMode` and an extended `blockClicked` payload with anchor geometry fields.

## Assumptions

- Single target chip in v1 (no multi-select).
- No text-format toolbar in this release.
- Existing dirty workspace content is intentionally preserved in the pre-change snapshot commit and tag.
