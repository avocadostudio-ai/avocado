# AI Site Editor — Adoption Guide for AI Coding Agents

Paste this into your AI coding agent's context (Claude Code, Codex, Cursor, Copilot, etc.) when it's helping you integrate AI Site Editor into your Next.js site.

---

## What you're integrating

AI Site Editor adds a chat-driven editing experience to your existing Next.js site. Users describe changes in natural language, and the system applies them as validated operations with live preview. Your site runs in an iframe inside the editor — no separate preview route needed.

**Requirements:** Next.js 15+ with App Router. The SDK package `@ai-site-editor/site-sdk` handles all integration plumbing.

## Step 1: Install the SDK

```bash
pnpm add @ai-site-editor/site-sdk
```

Peer dependencies: `next >=15.0.0`, `react >=19.0.0`.

## Step 2: Create 4 API route files

Each file is a one-liner. Create them exactly as shown.

**`app/api/draft/route.ts`** — Enables draft mode (sets cookies, redirects)
```ts
import { createDraftEnableHandler } from "@ai-site-editor/site-sdk"

export const GET = createDraftEnableHandler()
```

**`app/api/draft/disable/route.ts`** — Disables draft mode (clears cookies, redirects)
```ts
import { createDraftDisableHandler } from "@ai-site-editor/site-sdk"

export const GET = createDraftDisableHandler()
```

**`app/api/editor/components/route.ts`** — Serves component manifest to the editor
```ts
import { createComponentsHandler } from "@ai-site-editor/site-sdk"

export const { GET, OPTIONS } = createComponentsHandler()
```

**`app/api/editor/bootstrap-pages/route.ts`** — Feeds published pages to the editor
```ts
import { createBootstrapPagesHandler } from "@ai-site-editor/site-sdk"

export const { GET, OPTIONS } = createBootstrapPagesHandler(() => {
  // Return your published pages here.
  // Each page must match: { id, slug, title, blocks: [{ id, type, props }] }
  return getYourPublishedPages()
})
```

The `createBootstrapPagesHandler` callback must return an array of `PageDoc` objects. Implement this to read from your CMS, database, or filesystem.

## Step 3: Create a content loading module

Use `fetchEditorPage` and `fetchEditorSlugs` from the SDK to load draft content from the orchestrator when in editor mode. Fall back to your published content otherwise.

```ts
// lib/content.ts
import { fetchEditorPage, fetchEditorSlugs } from "@ai-site-editor/site-sdk/draft"

export async function getPage(slug: string, isDraft: boolean, session: string, siteId: string) {
  if (isDraft) return fetchEditorPage(slug, session, siteId)
  return getYourPublishedPage(slug) // your existing data source
}

export async function getNavSlugs(isDraft: boolean, session: string, siteId: string) {
  if (isDraft) {
    const slugs = await fetchEditorSlugs(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getYourPublishedSlugs() // your existing data source
}
```

## Step 4: Wire editor integration into your page

Add these SDK imports to your catch-all page component:

```tsx
// app/[[...slug]]/page.tsx
import { draftMode } from "next/headers"
import { buildSlug } from "@ai-site-editor/site-sdk"
import { resolveEditorContext } from "@ai-site-editor/site-sdk/draft"
import { renderBlocks, EditorOverlay } from "@ai-site-editor/site-sdk/editor"
import { getPage } from "@/lib/content"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Detect editor session from search params / cookies
  const editorCtx = await resolveEditorContext(resolvedSearch, {
    defaultSession: "dev",
    defaultSiteId: "my-site",
  })

  const editorMode = draft.isEnabled || !!editorCtx
  const session = editorCtx?.session ?? "dev"
  const siteId = editorCtx?.siteId ?? "my-site"

  const page = await getPage(slug, editorMode, session, siteId)
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

### What each SDK import does

| Import | Purpose |
|---|---|
| `resolveEditorContext()` | Reads session, siteId, editorOrigin from search params and cookies |
| `buildSlug()` | Converts `["pricing", "enterprise"]` → `"/pricing/enterprise"`, `undefined` → `"/"` |
| `renderBlocks()` | Renders blocks with error boundaries; pass `{ editable: true }` for editor selection attributes |
| `EditorOverlay` | Renders the PostMessage bridge for editor ↔ site communication |

## Step 5: Set environment variables

| Variable | App | Required | Description |
|---|---|---|---|
| `DRAFT_MODE_SECRET` | Site | Yes | Shared secret for draft mode activation (any random string) |
| `ORCHESTRATOR_URL` | Site | No | Orchestrator API URL (defaults to `http://localhost:4200`) |
| `NEXT_PUBLIC_ENABLE_EDITOR` | Site | No | Set to `"1"` to enable editor in production (enabled by default in dev) |
| `NEXT_PUBLIC_EDITOR_ORIGIN` | Site | No | Editor origin for PostMessage (e.g. `http://localhost:4100`) |
| `VITE_SITE_ORIGIN` | Editor | Yes | Your site's origin (e.g. `http://localhost:3000`) |
| `VITE_SITE_DRAFT_SECRET` | Editor | Yes | Must match the site's `DRAFT_MODE_SECRET` |
| `VITE_ORCHESTRATOR_URL` | Editor | Yes | Orchestrator API URL (e.g. `http://localhost:4200`) |

## Step 6: Verify the integration

Run these checks:

```bash
# 1. Start all apps
pnpm dev

# 2. Check manifest endpoint returns components
curl -s http://localhost:3000/api/editor/components | jq '.version, (.components | length)'

# 3. Check draft mode rejects bad secret
curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/api/draft?secret=wrong&redirect=/"
# Expected: 401

# 4. Check bootstrap-pages returns your pages
curl -s http://localhost:3000/api/editor/bootstrap-pages | jq '.pages | length'
```

Then open `http://localhost:4100` (the editor) — the editor header should show `Manifest` (not `Degraded`).

## Content data model

Your pages must conform to the `PageDoc` shape:

```ts
type PageDoc = {
  id: string             // unique page ID
  slug: string           // URL path (e.g. "/", "/pricing")
  title: string          // page title
  blocks: BlockInstance[] // ordered list of content blocks
  meta?: {
    title?: string
    description?: string
    ogImage?: string
  }
}

type BlockInstance = {
  id: string                    // unique block ID
  type: string                  // must match manifest component type
  props: Record<string, unknown> // block-specific properties
}
```

## Component type matching

The editor matches blocks by stable `type` IDs — not by DOM class names or CSS selectors.

Three things must share the same type string:

1. **Manifest** (`/api/editor/components`): `components[].type`
2. **Content** (your `PageDoc`): `block.type`
3. **Renderer** (your React code): the key you use to look up which component to render

Example:

```ts
// Your renderer mapping
const renderers: Record<string, React.ComponentType<any>> = {
  Hero: HeroSection,
  FeatureGrid: FeatureGridSection,
  CTA: CallToAction,
}

function YourBlockRenderer({ block }: { block: BlockInstance }) {
  const Component = renderers[block.type]
  if (!Component) return null
  return <Component {...block.props} />
}
```

## Available block types (built-in)

The SDK ships with 12 built-in block types. If you use these type strings, the manifest and renderers are provided automatically:

| Type | Description |
|---|---|
| `Hero` | Hero section with heading, subheading, CTA, image |
| `FeatureGrid` | Grid of feature cards with icons |
| `Testimonials` | Customer testimonial carousel/grid |
| `FAQAccordion` | Expandable FAQ section |
| `CTA` | Call-to-action banner |
| `Card` | Single content card |
| `CardGrid` | Grid of content cards |
| `RichText` | Free-form rich text content |
| `Stats` | Statistics/metrics display |
| `ContactForm` | Contact form layout |
| `TwoColumn` | Two-column layout with text and media |
| `Footer` | Page footer with links and branding |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Editor shows "Degraded" | `/api/editor/components` not responding or returning invalid JSON | Verify the route file exists and returns `{ version: 1, components: [...] }` |
| Blocks don't highlight on hover | Missing `getPreviewWrapperProps()` on block wrapper div | Add `{...getPreviewWrapperProps(editorMode, block.id, block.type)}` to each block's container |
| Draft mode doesn't activate | `DRAFT_MODE_SECRET` mismatch or missing | Ensure site and editor share the same secret value |
| Editor can't reach site | CORS blocked | SDK handlers add CORS headers automatically — check that `NEXT_PUBLIC_EDITOR_ORIGIN` is set |
| Page shows "Draft unavailable" | Orchestrator not running or unreachable | Start orchestrator (`pnpm dev:orchestrator`) and check `ORCHESTRATOR_URL` |

## Summary: what to create in your site

```
your-nextjs-site/
├── app/
│   ├── [[...slug]]/
│   │   └── page.tsx              ← wire resolveEditorContext, renderBlocks, EditorOverlay
│   └── api/
│       ├── draft/
│       │   ├── route.ts          ← createDraftEnableHandler()
│       │   └── disable/
│       │       └── route.ts      ← createDraftDisableHandler()
│       └── editor/
│           ├── components/
│           │   └── route.ts      ← createComponentsHandler()
│           └── bootstrap-pages/
│               └── route.ts      ← createBootstrapPagesHandler(cb)
├── lib/
│   └── content.ts                ← fetchEditorPage / fetchEditorSlugs from SDK
└── .env                          ← DRAFT_MODE_SECRET
```

6 files total. 4 are one-liner route handlers. The work is in `page.tsx` and `content.ts`.
