# Other High-Impact Improvements (After Core Editor UX)

Date: 2026-03-03  
Scope: Improvements to pursue after the initial editor-first focus items.

## Prioritization rule

- Prioritize changes that reduce editor mistakes, waiting time, and uncertainty.
- Avoid large architecture rewrites until editor outcomes clearly plateau.
- Only ship platform/dev abstractions when they directly unblock editor quality or speed.

## Phase 1: High impact, low architecture risk

1. Better chat intent disambiguation UI
- Add quick follow-up chips when intent is ambiguous: target block, target page, or change type.
- Surface this before planning to reduce wrong ops and retries.

2. Stronger inline editing confidence
- Show clear editable affordances only on truly editable fields.
- Add visible save/cancel feedback for inline edits and show the exact field name edited.

3. Improve multi-step request handling
- Break complex prompts into explicit staged actions in the UI before apply.
- Show progress per action so editors understand what completed vs what failed.

4. Cleaner error recovery path
- Replace generic errors with stable user-facing categories:
  - target not found
  - validation issue
  - ambiguous request
  - temporary system issue
- Attach one-click recovery suggestions to each category.

5. Better route/page awareness
- Keep active route, page title, and selected block pinned in the editor header.
- Warn when a request appears to target a different page than current context.

## Phase 2: Reliability + collaboration

1. Conflict awareness for concurrent editors
- Detect stale preview version before apply.
- Show non-blocking warning with option to refresh/merge intent.

2. Smarter history model
- Group low-level ops into one human action in undo stack.
- Add “restore to this point” from recent change timeline.

3. Publish race protection
- Soft lock or publish queue per `siteId + session`.
- Show clear ownership/status when another publish is in progress.

4. Lightweight draft autosave snapshots
- Save periodic snapshots for fast recovery from accidental destructive changes.
- Keep snapshot history short and UI-driven.

## Phase 3: Developer-facing improvements that directly help editors

1. Bridge protocol cleanup (minimal)
- Standardize one envelope format (`source`, `type`, `version`, `payload`).
- Keep backward compatibility for current `site-editor/v1` while migrating.

2. Adapter contract extraction (minimal)
- Extract interfaces only for:
  - load page/slugs
  - apply ops
  - publish
- Keep existing implementation as default adapter.

3. Conformance tests for integrations
- Add a compact test suite for message compatibility and op application behavior.
- Run it against current site integration before adding partner bridges.

4. Consolidate tool schemas via Zod (eliminate JSON Schema duplication)
- Tool manifests (`unsplash-search`, `image-generate`, `gdrive-browse`) manually duplicate JSON Schema objects and TypeScript types.
- Replace with Zod schemas → `z.infer<>` for types, `z.toJSONSchema()` for manifests.
- Extract shared image result item schema used by unsplash + gdrive.
- Adds runtime validation on LLM tool call inputs (currently bare `as` casts).
- Prevents schema drift where TS type and JSON Schema diverge silently.
- Future consideration: evaluate `json-schema-to-ts` for a JSON Schema-first approach if we pivot away from Zod.

## Metrics to decide if we are improving

1. Edit success rate
- % of requests applied without manual correction.

2. Time to confident publish
- Time from first edit message to publish action.

3. Undo dependency
- Avg undo count per session (should drop as precision improves).

4. Recovery quality
- % of failed requests resolved within one follow-up action.

5. Publish reversals
- Number of post-publish restores/reverts.

## What not to do yet

- Do not split into many new packages immediately.
- Do not redesign the whole storage/backend model before editor UX stabilizes.
- Do not optimize for external partner SDK ergonomics ahead of editor task completion quality.
