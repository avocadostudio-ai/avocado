# Editor-First AI + Bridge Plan

Date: 2026-03-03  
Scope: Prioritized plan focused on editor UX first, with bridge/product hardening second.

## Completed in this iteration

1. Inject explicit context into every AI request path
- Added structured `businessContext` and `siteContext` payloads from editor to:
  - `POST /chat`
  - `GET /chat/stream`
  - `POST /chat/variations`
- Context now includes explicit fields for:
  - site purpose
  - tone
  - constraints
  - site name / site id
- Orchestrator now normalizes these fields and appends them to prompt context consistently.

2. Added structured editor UI for AI context
- Site create/settings UI now includes:
  - `Preferred tone`
  - `AI constraints` (comma/newline list)
- Values are persisted in site config storage and sent in AI requests.

3. Removed irrelevant AI context
- `hosting` is no longer injected into AI prompt context.

## Immediate next (highest impact for editors)

1. Faster, steadier preview feedback
- Prefer optimistic patch updates and only full-refresh on reject/mismatch.
- Reduce visible “jump” during multi-op apply.

2. Better scope visibility before apply
- Always show active edit scope in UI (page/block/field).
- Show planned targets briefly before execution.

3. Safer destructive operations
- Add clear confirm + instant undo affordance for remove actions.
- Keep undo labels human-readable.

4. Publish confidence layer
- Add pre-publish checklist and post-publish status panel with quick restore link.

## Storyblok-inspired improvements (adapted)

1. Thin wrapper, strong core
- Move bridge lifecycle/protocol handling into one core module, keep framework hooks thin.

2. Strict runtime gating
- Only activate bridge behavior in real editor/preview context.

3. Stale update protection
- Guard against stale events with page/version/session matching.

4. Runtime mode exports
- Keep compatibility paths explicit (`client` vs `ssr` style integration entrypoints).

## Contentful-inspired improvements (adapted)

1. Protocol discipline
- Single envelope format with explicit `source`, `type`, `version`, `payload`.
- Keep compatibility for existing `site-editor/v1` while migrating.

2. First-class subscriptions
- Use subscription IDs and explicit unsubscribe for live update streams.

3. Inspector and updates separated
- Keep field tagging/selection concerns isolated from mutation transport.

4. Origin + message validation hardening
- Validate both message source and allowed origin on every inbound bridge event.

## Phase order (to avoid overengineering)

1. Editor UX reliability and confidence (now)
2. Minimal bridge protocol cleanup and hardening
3. Lightweight adapter interfaces (`load`, `apply`, `publish`)
4. Broader partner SDK abstraction only after editor metrics improve

## Success metrics

1. Edit success on first attempt
2. Median time from first prompt to publish
3. Undo frequency per session
4. Failed request recovery in one follow-up
5. Publish rollback frequency
