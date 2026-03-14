# Next.js MVP Onboarding (Embedded Mode)

This is the default onboarding path for any Next.js site. Estimated time: **~30 minutes**.

**Start here first**: [Integration overview](README.md)

## Prerequisites

- Next.js 14+ with App Router (Pages Router works but templates assume App Router)
- AI Site Editor monorepo running locally (`pnpm dev`)
- A shared secret string for draft mode (any random value — set as `DRAFT_MODE_SECRET`)

## Goal
- Keep existing site routes.
- Do not require a `/preview` route.
- Enable editor preview through Next.js Draft Mode cookies.

Related:
- `docs/integration/editor-quickstart.md` for editor iframe/bootstrap URL templates.
- `docs/integration/templates/nextjs-embedded/` for copy-paste API route files.
- `docs/integration/nextjs-mvp-adoption-example.md` for a full page wiring example.

## Required contract

1. Add component manifest endpoint:
- `GET /api/editor/components`
- returns available component types and prop schemas for safe ops
- generated from adopter-owned component registry (recommended)

Template files for this:
- `lib/site-component-registry.ts`
- `lib/editor-components-manifest.ts`
- `lib/editor-components-contract.ts`

2. Add Draft Mode entry and exit endpoints:
- `GET /api/draft?secret=...&redirect=/target-path`
- `GET /api/draft/disable?redirect=/target-path`

3. Add secret validation and safe redirect behavior:
- reject missing/invalid secrets
- only allow internal redirects (paths starting with `/`)

4. In page data loading:
- when Draft Mode is disabled, read published data only
- when Draft Mode is enabled, read draft source (CMS/orchestrator/etc.)
  - starter snippets: `docs/integration/templates/nextjs-embedded/lib/`

5. Editor iframe/bootstrap URL pattern:
- `/api/draft?secret=<DRAFT_MODE_SECRET>&redirect=/<slug>?<context>`
  - starter helper: `docs/integration/templates/nextjs-embedded/editor/build-draft-url.ts`

## Component manifest shape (MVP)

Example response:

```json
{
  "version": 1,
  "components": [
    {
      "type": "Hero",
      "displayName": "Hero",
      "editablePaths": ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt"],
      "propsSchema": { "type": "object", "properties": { "heading": { "type": "string" } } },
      "defaultProps": { "heading": "New hero heading" }
    }
  ]
}
```

Behavior:
- manifest present: enable structural operations (add/remove/reorder/update props)
- manifest missing: degraded mode only (read-only preview or text-only edits)

## How Component Matching Works

The editor does not infer components from DOM class names.
It matches by stable component `type` IDs.

Contract:
1. Manifest entry: `components[].type`
2. Content block: `block.type`
3. Site renderer registry key: same `type`

Example:

```json
{
  "components": [
    { "type": "Hero", "propsSchema": { "type": "object" } },
    { "type": "FeatureGrid", "propsSchema": { "type": "object" } }
  ]
}
```

```json
{
  "id": "p_home",
  "slug": "/",
  "blocks": [
    { "id": "b1", "type": "Hero", "props": { "heading": "Hello" } },
    { "id": "b2", "type": "FeatureGrid", "props": { "title": "Why us" } }
  ]
}
```

```ts
const rendererRegistry = {
  Hero: HeroSection,
  FeatureGrid: FeatureGridSection
}
```

If a block type exists in content but not in manifest:
- block can still render on site
- editor must not run structural ops for that type (degraded mode for that block/type)

## Environment variables

- Site:
  - `DRAFT_MODE_SECRET`
  - `ORCHESTRATOR_URL` (or your draft backend origin)
- Editor:
  - `VITE_SITE_ORIGIN`
  - `VITE_SITE_DRAFT_SECRET` (must match `DRAFT_MODE_SECRET`)

## 30-minute checklist

1. Implement `/api/draft` and `/api/draft/disable`.
2. Implement `/api/editor/components`.
3. Verify `/api/draft?secret=wrong` returns `401`.
4. Verify `/api/draft?secret=valid&redirect=/` returns redirect + draft cookie.
5. Verify public route (no draft cookie) does not call draft backend.
6. Point editor iframe to draft entry URL.

## Optional later upgrade

If you want stronger isolation later, add a dedicated `/preview/*` route group.
This is optional and not part of MVP onboarding.
