# @ai-site-editor/site-sdk

SDK for integrating any Next.js site with the AI Site Editor. Provides the contract between your site and the editor — handles draft mode, block rendering, editor overlay, and publishing.

## Quick Start

### 1. Install

```bash
npm install @ai-site-editor/site-sdk @ai-site-editor/blocks @ai-site-editor/shared
```

### 2. Create the page component

```tsx
// app/[[...slug]]/page.tsx
import { createSitePage } from "@ai-site-editor/site-sdk/page"
import { getPage, getSlugs, getSiteConfig } from "../../lib/my-cms"

const { Page, generateStaticParams } = createSitePage({
  siteId: "my-site",
  getPage,       // (slug: string) => Promise<PageDoc | null>
  getSlugs,      // () => Promise<string[]>
  getSiteConfig, // () => Promise<SiteConfig>  (optional)
  footer: {      // optional footer block
    id: "footer", type: "Footer",
    props: { copyright: "© 2026 My Site", columns: [] }
  },
})

export default Page
export { generateStaticParams }
```

### 3. Create the editor API route

```tsx
// app/api/editor/[...path]/route.ts
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { getPages } from "../../lib/my-cms"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getPages(),
  onPublish: async (pages, config) => {
    // Write pages to your CMS
    return { ok: true }
  },
  publishSecret: process.env.PUBLISH_TOKEN,
})
```

### 4. Add styles

```tsx
// app/layout.tsx
import "@ai-site-editor/blocks/styles.css"
```

### 5. Set environment variables

```env
# Required
ORCHESTRATOR_URL=http://localhost:4200
DRAFT_MODE_SECRET=<random-secret>

# Optional
PUBLISH_TOKEN=<publish-auth-token>
```

That's it. Your site now works with the AI editor.

## What You Implement

| Function | Signature | Purpose |
|---|---|---|
| `getPage` | `(slug: string) => Promise<PageDoc \| null>` | Fetch a page from your CMS |
| `getSlugs` | `() => Promise<string[]>` | List all page slugs (for static generation) |
| `getSiteConfig` | `() => Promise<SiteConfig>` | Site name, logo, nav labels (optional) |
| `onPublish` | `(pages, config) => Promise<{ok, error?}>` | Persist published content to your CMS |

## Exports

| Import | What it provides |
|---|---|
| `@ai-site-editor/site-sdk` | Types (`PageDoc`, `BlockInstance`), `buildSlug`, `renderBlocks` |
| `@ai-site-editor/site-sdk/page` | `createSitePage` — page component factory |
| `@ai-site-editor/site-sdk/routes` | `createEditorApiHandler` — API route factory |
| `@ai-site-editor/site-sdk/draft` | `resolveEditorContext`, `fetchEditorPage` |
| `@ai-site-editor/site-sdk/editor` | `renderBlocks`, `EditorOverlay` |
| `@ai-site-editor/site-sdk/navigation` | `buildNavItems`, `buildSiteHeaderBlock` |

## API Contract

Your site exposes these endpoints via `createEditorApiHandler`:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/editor/draft` | GET | Enable draft mode (sets cookies) |
| `/api/editor/draft/disable` | GET | Disable draft mode |
| `/api/editor/blocks` | GET | Return block manifest (schemas + defaults) |
| `/api/editor/pages` | GET | Return all published pages |
| `/api/editor/publish` | POST | Receive pages from editor, persist to CMS |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ORCHESTRATOR_URL` | Yes (dev) | URL of the AI editor orchestrator. Defaults to `http://localhost:4200` in dev. |
| `DRAFT_MODE_SECRET` | Yes | Secret for enabling Next.js draft mode. Must match editor's `VITE_SITE_DRAFT_SECRET`. |
| `PUBLISH_TOKEN` | No | If set, publish requests must include this token in `x-publish-token` header. |
| `EDITOR_CORS_ORIGINS` | No | Comma-separated origins allowed for editor API CORS. Defaults to `http://localhost:4100`. |

## Types

```typescript
type PageDoc = {
  id: string
  slug: string
  title: string
  updatedAt: string
  blocks: BlockInstance[]
  meta?: { title?: string; description?: string; ogImage?: string }
}

type BlockInstance = {
  id: string
  type: string  // e.g., "Hero", "CTA", "FeatureGrid"
  props: Record<string, unknown>
}

type SiteConfig = {
  name?: string
  logo?: string
  navLabels?: Record<string, string>  // e.g., { "/pricing": "Plans" }
}
```

## Examples

See working integrations in the monorepo:

- `examples/sample-site/` — JSON file content (simplest)
- `examples/contentful-site/` — Contentful CMS
- `examples/sanity-site/` — Sanity CMS + Studio
- `examples/strapi-site/` — Strapi CMS (self-hosted)
