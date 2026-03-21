# Next.js MVP Onboarding (Embedded Mode)

This is the default onboarding path for any Next.js site. Estimated time: **~30 minutes**.

**Start here first**: [Integration overview](README.md)

## Prerequisites

- Next.js 15+ with App Router
- `@ai-site-editor/site-sdk` installed as a dependency
- AI Site Editor monorepo running locally (`pnpm dev`)
- A shared secret string for draft mode (any random value — set as `DRAFT_MODE_SECRET`)

## Goal
- Keep existing site routes.
- Do not require a `/preview` route.
- Enable editor preview through Next.js Draft Mode cookies.

Related:
- `docs/integration/editor-quickstart.md` for editor iframe/bootstrap URL templates.
- `docs/integration/nextjs-mvp-adoption-example.md` for a full page wiring example.

## Step 1: Create API route handlers

The SDK provides handler factories — each API route is a one-liner:

**`app/api/draft/route.ts`**
```ts
import { createDraftEnableHandler } from "@ai-site-editor/site-sdk"

export const GET = createDraftEnableHandler()
```

**`app/api/draft/disable/route.ts`**
```ts
import { createDraftDisableHandler } from "@ai-site-editor/site-sdk"

export const GET = createDraftDisableHandler()
```

**`app/api/editor/components/route.ts`**
```ts
import { createComponentsHandler } from "@ai-site-editor/site-sdk"

export const { GET, OPTIONS } = createComponentsHandler()
```

**`app/api/editor/bootstrap-pages/route.ts`**
```ts
import { createBootstrapPagesHandler } from "@ai-site-editor/site-sdk"
import { getPublishedPage, getPublishedSlugs } from "@/lib/published-content-api"

export const { GET, OPTIONS } = createBootstrapPagesHandler(() => {
  return getPublishedSlugs()
    .map((slug) => getPublishedPage(slug))
    .filter((page): page is NonNullable<typeof page> => page !== null)
})
```

The `createBootstrapPagesHandler` takes a callback that returns your published pages. Implement `getPublishedPage` and `getPublishedSlugs` to read from your CMS, file system, or database.

## Step 2: Wire draft content loading

Use `fetchEditorPage` and `fetchEditorSlugs` from the SDK to load draft content from the orchestrator:

```ts
// lib/content.ts
import { fetchEditorPage, fetchEditorSlugs } from "@ai-site-editor/site-sdk/draft"
import { getPublishedPage, getPublishedSlugs } from "./published-content-api"

export async function getPage(slug: string, isDraft: boolean, session: string, siteId: string) {
  if (isDraft) return fetchEditorPage(slug, session, siteId)
  return getPublishedPage(slug)
}

export async function getNavSlugs(isDraft: boolean, session: string, siteId: string) {
  if (isDraft) {
    const slugs = await fetchEditorSlugs(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getPublishedSlugs()
}
```

## Step 3: Add editor integration to your page

Use `resolveEditorContext` to detect editor sessions, and SDK UI components for the preview overlay:

```tsx
// app/[[...slug]]/page.tsx
import { draftMode } from "next/headers"
import { buildSlug } from "@ai-site-editor/site-sdk"
import { resolveEditorContext } from "@ai-site-editor/site-sdk/draft"
import { renderBlocks, EditorOverlay } from "@ai-site-editor/site-sdk/editor"

export default async function SitePage({ params, searchParams }) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Resolve editor context from search params and cookies
  const editorCtx = await resolveEditorContext(resolvedSearch, {
    defaultSession: "dev",
    defaultSiteId: "my-site"
  })

  const editorMode = draft.isEnabled || !!editorCtx

  const page = await getPage(slug, editorMode, editorCtx?.session ?? "dev", editorCtx?.siteId ?? "my-site")
  if (!page) return <main><h1>Not found</h1></main>

  return (
    <>
      <main>
        {renderBlocks(page.blocks, { editable: editorMode })}
      </main>
      {editorMode && (
        <EditorOverlay slug={slug} editorOrigin={editorCtx?.editorOrigin ?? ""} />
      )}
    </>
  )
}
```

Key SDK utilities used:
- `resolveEditorContext()` — resolves session/siteId/editorOrigin from search params and cookies
- `buildSlug()` — converts route params array to slug string (e.g., `["pricing"]` → `"/pricing"`)
- `renderBlocks()` — renders blocks with error boundaries; pass `{ editable: true }` to add editor selection attributes
- `EditorOverlay` — renders the PostMessage bridge for editor ↔ site communication

## Component manifest shape (MVP)

The SDK's `createComponentsHandler()` generates this automatically from the block registry:

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

If a block type exists in content but not in manifest:
- block can still render on site
- editor must not run structural ops for that type (degraded mode for that block/type)

## Environment variables

| Variable | App | Required | Description |
|---|---|---|---|
| `DRAFT_MODE_SECRET` | Site | Yes | Shared secret for draft mode activation |
| `ORCHESTRATOR_URL` | Site | No | Orchestrator API base URL (defaults to `http://localhost:4200`) |
| `VITE_SITE_ORIGIN` | Editor | Yes | Site origin for iframe target (e.g. `http://localhost:3000`) |
| `VITE_SITE_DRAFT_SECRET` | Editor | Yes | Must match the site's `DRAFT_MODE_SECRET` |

## 30-minute checklist

1. Install `@ai-site-editor/site-sdk`.
2. Create 4 API route files using SDK handler factories.
3. Wire `resolveEditorContext()` and `fetchEditorPage()` into page data loading.
4. Add `EditorOverlay`, `BlockErrorBoundary`, and `getPreviewWrapperProps()` to page renderer.
5. Set `DRAFT_MODE_SECRET` env var.
6. Verify `/api/draft?secret=wrong` returns `401`.
7. Verify `/api/draft?secret=valid&redirect=/` redirects and sets draft cookie.
8. Verify `/api/editor/components` returns manifest JSON.
9. Confirm editor header shows `Manifest` (not `Degraded`).

## Optional later upgrade

If you want stronger isolation later, add a dedicated `/preview/*` route group.
This is optional and not part of MVP onboarding.
