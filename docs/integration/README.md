# Integration Docs (Start Here)

Use this page as the entry point for onboarding any Next.js site.

## Recommended reading order

1. `docs/integration/nextjs-mvp-embedded.md`
2. `docs/integration/editor-quickstart.md`
3. `docs/integration/nextjs-mvp-adoption-example.md`
4. `docs/integration/templates/nextjs-embedded/README.md`

## MVP integration model

- Source of truth: adopter-owned component registry in code.
- Transport contract: `GET /api/editor/components` manifest JSON generated from that registry.
- Preview bootstrap: Next.js Draft Mode (`/api/draft`, `/api/draft/disable`).
- Fallback behavior: if manifest is missing/invalid, editor runs in degraded mode (no structural edits).

## Required endpoints

- `GET /api/editor/components`
- `GET /api/draft?secret=...&redirect=...`
- `GET /api/draft/disable?redirect=...`

## Required environment variables

- Site:
  - `DRAFT_MODE_SECRET`
- Editor:
  - `VITE_SITE_ORIGIN`
  - `VITE_SITE_DRAFT_SECRET`

## Adoption checklist

1. Add local component registry in site code.
2. Generate manifest from registry and expose `/api/editor/components`.
3. Add draft mode routes and secret validation.
4. Verify CORS for editor origin on `/api/editor/components` in local/dev.
5. Confirm editor header shows `Manifest` (not `Degraded`).

## Quick validation script

Run:

```bash
./docs/integration/scripts/check-manifest.sh http://localhost:3000
```

Expected:
- prints `PASS: version=..., components=...`
