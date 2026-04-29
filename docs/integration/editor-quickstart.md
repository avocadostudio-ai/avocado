# Editor Integration Quickstart (Embedded Draft Mode)

Use this when integrating the editor with any existing Next.js site.

**Start here first**: [Integration overview](README.md)

## Prerequisites

- Next.js 15+ site running locally (App Router)
- `@ai-site-editor/site-sdk` installed as a dependency
- Avocado Studio monorepo running (`pnpm dev`)
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

// app/api/editor/blocks/route.ts
import { createBlocksHandler } from "@ai-site-editor/site-sdk"
export const { GET, OPTIONS } = createBlocksHandler()

// app/api/editor/pages/route.ts
import { createPagesHandler } from "@ai-site-editor/site-sdk"
export const { GET, OPTIONS } = createPagesHandler(() => fetchYourPublishedPages())
```

The SDK handles secret validation, CORS headers, cookie management, and safe redirects automatically.

## Required environment variables

| Variable | App | Required | Description |
|---|---|---|---|
| `DRAFT_MODE_SECRET` | Site | Yes | Shared secret for draft mode activation |
| `VITE_SITE_ORIGIN` | Editor | Yes | Site origin for iframe target (e.g. `http://localhost:3000`) |
| `VITE_SITE_DRAFT_SECRET` | Editor | Yes | Must match the site's `DRAFT_MODE_SECRET` |

## Iframe bootstrap URL (enter draft mode)

Pattern:

```text
${VITE_SITE_ORIGIN}/api/draft?secret=${VITE_SITE_DRAFT_SECRET}&redirect=${encodeURIComponent(pathWithQuery)}
```

Where `pathWithQuery` is your target site path plus context query params, for example:

```text
/pricing?session=dev&siteId=avocado-stories
```

Full example:

```text
http://localhost:3000/api/draft?secret=top-secret&redirect=%2Fpricing%3Fsession%3Ddev%26siteId%3Davocado-stories
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

1. `GET /api/editor/blocks` returns valid block manifest JSON.
2. `GET /api/editor/pages` returns `{ pages: [...] }` with published pages.
3. Wrong secret returns `401` from `/api/draft`.
4. Valid secret redirects and sets draft cookie.
5. `/api/draft/disable` clears draft cookie and redirects.
6. Same page renders published content when draft cookie is absent.

## Contract self-check (recommended before onboarding)

Run these in the site project:

```bash
pnpm typecheck
pnpm test
curl -s http://localhost:3000/api/editor/blocks | jq '.version, (.blocks | length)'
```

Expected:
- manifest route returns `version` and non-zero block count
- editor header shows `Manifest` (not `Degraded`)
