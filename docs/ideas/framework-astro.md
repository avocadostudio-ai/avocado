# Framework Support: Astro

## Framework Characteristics
- Multi-framework island architecture — supports React, Vue, Svelte, Solid components
- SSG by default, SSR via `output: "server"` or `output: "hybrid"`
- File-based routing in `src/pages/`
- API routes via `src/pages/api/` (SSR mode only)
- Astro components are `.astro` (server-rendered HTML templates, zero JS by default)
- Client-side interactivity via `client:load`, `client:visible`, etc. directives
- Content Collections for static content

## SDK Abstraction Mapping

### 1. Editor API Routes
**Next.js:** `app/api/editor/[...path]/route.ts`
**Astro:** `src/pages/api/editor/[...path].ts` (requires SSR mode)

Astro API routes use standard Web API `Request/Response` — **direct match** with `createEditorApiHandler()`.

```ts
// src/pages/api/editor/[...path].ts
import type { APIRoute } from "astro"
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"

const handler = createEditorApiHandler({
  getPages: () => getPublishedPages(),
  getManifest: () => ({ version: 1, blocks: getBlockRegistry() }),
})

export const GET: APIRoute = async ({ request }) => handler.GET(request)
export const POST: APIRoute = async ({ request }) => handler.POST(request)
export const OPTIONS: APIRoute = async ({ request }) => handler.OPTIONS(request)
```

**No SDK changes needed** — Astro's API routes already use Web API Request/Response.

### 2. Draft Mode
**Next.js:** `draftMode()` from `next/headers`
**Astro:** No built-in draft mode. Use cookies via `Astro.cookies` API.

Astro's SSR mode provides `Astro.cookies` on every request. Draft context can be resolved server-side in `.astro` page components.

```ts
// src/lib/draft.ts
import { resolveDraftContextCore } from "@ai-site-editor/site-sdk/draft/core"

export function resolveDraft(cookies: AstroCookies) {
  return resolveDraftContextCore({
    isDraftMode: Boolean(cookies.get("ase-draft-session")?.value),
    getCookie: (name) => cookies.get(name)?.value,
  })
}
```

**`DraftRouteAdapter`:**
```ts
// src/pages/api/editor/draft/enable.ts
import type { APIRoute } from "astro"
import { handleDraftEnableCore } from "@ai-site-editor/site-sdk/routes/core"

export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  return handleDraftEnableCore(request, {
    enableDraftMode: async () => { /* cookies set via createRedirect */ },
    disableDraftMode: async () => {
      cookies.delete("ase-draft-session")
      cookies.delete("ase-draft-site")
    },
    createRedirect: (url, setCookies) => {
      // Astro redirect + set cookies in response
      const res = new Response(null, { status: 302, headers: { Location: url.toString() } })
      for (const c of setCookies ?? []) res.headers.append("Set-Cookie", serializeCookie(c))
      return res
    },
  })
}
```

### 3. Preview Bridge
**Astro:** Supports React components as islands. Can use `PreviewBridge` React component directly.

```astro
---
// src/components/EditorOverlay.astro
---
<div id="editor-overlay">
  <!-- React island for preview bridge -->
</div>
```

```tsx
// src/components/PreviewBridgeIsland.tsx (React component)
import { PreviewBridge } from "@ai-site-editor/preview-adapter"

export default function PreviewBridgeIsland() {
  return <PreviewBridge />
}
```

```astro
---
import PreviewBridgeIsland from "./PreviewBridgeIsland"
---
<PreviewBridgeIsland client:load />
```

**Caveat:** `PreviewBridge` currently uses `next/navigation` (`useRouter`, `usePathname`). Needs a framework-agnostic variant that uses `window.location` and `history.pushState` directly, or accepts navigation callbacks.

### 4. Block Rendering
**Astro's key advantage:** React components work as islands. `@ai-site-editor/blocks` can be used directly.

```astro
---
// src/components/BlockRenderer.astro
import { SharedBlockRenderer } from "@ai-site-editor/blocks"

const { block } = Astro.props
---
<div data-block-id={block.id} data-block-type={block.type}>
  <SharedBlockRenderer block={block} client:load />
</div>
```

**Image handling:** `BlockImage` currently uses `next/image`. For Astro, replace with Astro's `<Image>` component or a plain `<img>` tag. The SDK should make the image component pluggable:

```tsx
// Proposed: renderBlocks accepts an imageComponent override
renderBlocks(blocks, { imageComponent: AstroImage })
```

Or simpler: `BlockImage` detects if `next/image` is available and falls back to `<img>`.

### 5. Page Component Pattern
```astro
---
// src/pages/[...slug].astro
import { resolveDraft } from "../lib/draft"
import { fetchEditorPage } from "@ai-site-editor/site-sdk"
import BlockRenderer from "../components/BlockRenderer.astro"
import PreviewBridgeIsland from "../components/PreviewBridgeIsland"
import { getPublishedPage } from "../lib/content"

const slug = Astro.params.slug ?? "home"
const draft = resolveDraft(Astro.cookies)

let page
if (draft.isEditor) {
  page = await fetchEditorPage(draft.orchestratorUrl, draft.session, draft.siteId, slug)
} else {
  page = await getPublishedPage(slug)
}

if (!page) return Astro.redirect("/404")
---
<html>
<body>
  {page.blocks.map(block => <BlockRenderer block={block} />)}
  {draft.isEditor && <PreviewBridgeIsland client:load />}
</body>
</html>
```

### 6. SSR Requirement
Draft mode and editor API routes require server-side execution. Sites must use:

```ts
// astro.config.mjs
export default defineConfig({
  output: "hybrid", // or "server"
  adapter: node(),  // or vercel(), netlify(), etc.
})
```

Pages that need draft mode must opt out of prerendering:
```astro
---
export const prerender = false
---
```

Static pages can still be prerendered for production performance.

## What Needs to Be Built in the SDK
1. **Framework-agnostic `PreviewBridge` variant** — uses `window.location` / `history.pushState` instead of `next/navigation` (or accepts navigation callbacks)
2. **Pluggable `BlockImage`** — falls back to `<img>` when `next/image` is unavailable
3. **Documentation** — Astro integration guide

## What the Site Developer Implements
1. `astro.config.mjs` with `output: "hybrid"` and SSR adapter
2. API route catch-all wiring `createEditorApiHandler` (direct, no adapter needed)
3. Draft cookie helper using `Astro.cookies`
4. Page component with draft/published branching
5. Block renderer (can use `@ai-site-editor/blocks` React components as islands)

## Effort Estimate
- **SDK changes:** ~1-2 days (PreviewBridge agnostic variant, BlockImage fallback)
- **Reference Astro site:** ~2 days (API routes, page component, block rendering)
- **Total:** ~3-4 days for a working Astro example site

## Priority
**P1** — Astro's island architecture means React blocks work out of the box. Lowest integration effort after React Router. API routes use standard Web API. Only the PreviewBridge and BlockImage need minor SDK changes.
