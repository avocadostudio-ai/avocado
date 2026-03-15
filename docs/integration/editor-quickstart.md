# Editor Integration Quickstart (Embedded Draft Mode)

Use this when integrating the editor with any existing Next.js site.

**Start here first**: [Integration overview](README.md)

## Prerequisites

- Next.js 15+ site running locally (App Router)
- `@ai-site-editor/site-sdk` installed as a dependency
- AI Site Editor monorepo running (`pnpm dev`)
- `DRAFT_MODE_SECRET` set in both site and editor `.env`

## Quick setup with `@ai-site-editor/site-sdk`

The SDK provides handler factories for all required endpoints. Each API route is a one-liner import:

```ts
// app/api/draft/route.ts
import { createDraftEnableHandler } from "@ai-site-editor/site-sdk"
export const GET = createDraftEnableHandler()

// app/api/draft/disable/route.ts
import { createDraftDisableHandler } from "@ai-site-editor/site-sdk"
export const GET = createDraftDisableHandler()

// app/api/editor/components/route.ts
import { createComponentsHandler } from "@ai-site-editor/site-sdk"
export const { GET, OPTIONS } = createComponentsHandler()

// app/api/editor/bootstrap-pages/route.ts
import { createBootstrapPagesHandler } from "@ai-site-editor/site-sdk"
export const { GET, OPTIONS } = createBootstrapPagesHandler(() => fetchYourPublishedPages())
```

The SDK handles secret validation, CORS headers, cookie management, and safe redirects automatically.

## Required env vars

- Site:
  - `DRAFT_MODE_SECRET`
- Editor:
  - `VITE_SITE_ORIGIN`
  - `VITE_SITE_DRAFT_SECRET` (same value as site `DRAFT_MODE_SECRET`)

## Iframe bootstrap URL (enter draft mode)

Pattern:

```text
${VITE_SITE_ORIGIN}/api/draft?secret=${VITE_SITE_DRAFT_SECRET}&redirect=${encodeURIComponent(pathWithQuery)}
```

Where `pathWithQuery` is your target site path plus context query params, for example:

```text
/pricing?session=dev&siteId=adventure-atlas
```

Full example:

```text
http://localhost:3000/api/draft?secret=top-secret&redirect=%2Fpricing%3Fsession%3Ddev%26siteId%3Dadventure-atlas
```

## Exit draft mode (view live page)

Pattern:

```text
${VITE_SITE_ORIGIN}/api/draft/disable?redirect=${encodeURIComponent(path)}
```

Example:

```text
http://localhost:3000/api/draft/disable?redirect=%2Fpricing
```

## Minimal behavior checks

1. `GET /api/editor/components` returns valid component manifest JSON.
2. `GET /api/editor/bootstrap-pages` returns `{ pages: [...] }` with published pages.
3. Wrong secret returns `401` from `/api/draft`.
4. Valid secret redirects and sets draft cookie.
5. `/api/draft/disable` clears draft cookie and redirects.
6. Same page renders published content when draft cookie is absent.

## Contract self-check (recommended before onboarding)

Run these in the site project:

```bash
pnpm typecheck
pnpm test
curl -s http://localhost:3000/api/editor/components | jq '.version, (.components | length)'
```

Expected:
- manifest route returns `version` and non-zero component count
- editor header shows `Manifest` (not `Degraded`)
