# Site Editor Missing Ops Plan

## Goal
Close critical operation gaps for a production-grade site editor while keeping the existing `Operation` model stable.

## Missing Ops Backlog
1. `duplicate_block` (implement first)
2. `duplicate_page` (implement first)
3. `add_item` for list props (`features`, `cards`, `items`) (implemented)
4. `update_item` for list props by index/key (implemented)
5. `remove_item` for list props by index (implemented)
6. `move_item` for list props by index (implemented)
7. `replace_block_type` (migrate section type while preserving compatible content)
8. `undo_last_change` (session-wide transaction undo)
9. `redo_last_change` (session-wide transaction redo)
10. `update_page_meta` (SEO/social metadata fields)
11. `update_site_settings` (global nav/footer/branding/theme settings)

## Rollout Phases
1. Phase 1: `duplicate_block`, `duplicate_page`
   - Add to shared operation schema.
   - Support planner op names and alias normalization.
   - Apply atomically in orchestrator with validation and collision-safe IDs/slugs.
2. Phase 2: List item ops (`add_item`, `update_item`, `remove_item`, `move_item`) (implemented)
   - Add precise nested editing without full-array replacement.
3. Phase 3: Structural transform + global history
   - `replace_block_type`, `undo_last_change`, `redo_last_change`.
4. Phase 4: Metadata and site-wide settings
   - `update_page_meta`, `update_site_settings`.

## Status
- `duplicate_block`: Implemented in this change set.
- `duplicate_page`: Implemented in this change set.
- `add_item`: Implemented in this change set.
- `update_item`: Implemented in this change set.
- `remove_item`: Implemented in this change set.
- `move_item`: Implemented in this change set.
- Remaining ops: Planned, not implemented.
