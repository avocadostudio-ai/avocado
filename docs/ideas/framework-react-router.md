# Framework Support: React Router 7 / Remix

## Framework Characteristics
- React-based — same runtime as Next.js, blocks and preview bridge work directly
- File-based routing with `app/routes/` convention
- `loader` (GET) and `action` (POST) for server-side data loading
- Resource routes for API endpoints (no UI, return raw responses)
- Cookie session storage for stateful server-side data
- SSR by default, supports SPA mode
- Vite-based build system
- React Router v7 unified Remix and React Router — "Remix" is now React Router with framework features

## SDK Abstraction Mapping

### 1. Editor API Routes
**Next.js:** `app/api/editor/[...path]/route.ts`
**React Router:** `app/routes/api.editor.$.tsx` (splat route as resource route)

React Router resource routes return `Response` objects from `loader`/`action` — **direct match** with `createEditorApiHandler()`.

```tsx
// app/routes/api.editor.$.tsx
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router"

const handler = createEditorApiHandler({
  getPages: () => getPublishedPages(),
  getManifest: () => ({ version: 1, blocks: getBlockRegistry() }),
})

export async function loader({ request }: LoaderFunctionArgs) {
  return handler.GET(request)
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return handler.OPTIONS(request)
  return handler.POST(request)
}
```

**No SDK changes needed** — React Router uses standard Web API `Request/Response`.

### 2. Draft Mode
**Next.js:** `draftMode()` + `__prerender_bypass` cookie
**React Router:** Cookie session storage — idiomatic and well-supported.

```ts
// app/lib/draft-session.server.ts
import { createCookieSessionStorage } from "react-router"

export const draftSession = createCookieSessionStorage({
  cookie: {
    name: "ase-draft",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secrets: [process.env.DRAFT_MODE_SECRET ?? "s3cret"],
  },
})
```

**`DraftModeAdapter` implementation:**
```ts
// app/lib/draft.server.ts
import { resolveDraftContextCore } from "@ai-site-editor/site-sdk/draft/core"
import { draftSession } from "./draft-session.server"

export async function resolveDraft(request: Request) {
  const session = await draftSession.getSession(request.headers.get("Cookie"))
  return resolveDraftContextCore({
    isDraftMode: Boolean(session.get("session")),
    getCookie: (name) => {
      if (name === "ase-draft-session") return session.get("session")
      if (name === "ase-draft-site") return session.get("siteId")
      if (name === "ase-editor-origin") return session.get("editorOrigin")
      // Fall back to raw cookie header
      const cookies = request.headers.get("Cookie") ?? ""
      const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
      return match?.[1]
    },
  })
}
```

**`DraftRouteAdapter` implementation:**
```ts
// app/routes/api.editor.draft.tsx
import { draftSession } from "~/lib/draft-session.server"
import { handleDraftEnableCore } from "@ai-site-editor/site-sdk/routes/core"

export async function loader({ request }: LoaderFunctionArgs) {
  const session = await draftSession.getSession(request.headers.get("Cookie"))

  return handleDraftEnableCore(request, {
    enableDraftMode: async () => {
      const url = new URL(request.url)
      session.set("session", url.searchParams.get("session"))
      session.set("siteId", url.searchParams.get("siteId"))
    },
    disableDraftMode: async () => {
      session.unset("session")
      session.unset("siteId")
    },
    createRedirect: async (url) => {
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.toString(),
          "Set-Cookie": await draftSession.commitSession(session),
        },
      })
    },
  })
}
```

### 3. Preview Bridge
**Next.js:** `PreviewBridge` uses `useRouter()` and `usePathname()` from `next/navigation`.
**React Router:** Replace with `useNavigate()` and `useLocation()` from `react-router`.

```tsx
// app/components/EditorOverlay.tsx
import { useEffect } from "react"
import { useNavigate, useLocation } from "react-router"
import { PreviewBridgeCore } from "@ai-site-editor/preview-adapter/core"

export function EditorOverlay() {
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    const bridge = new PreviewBridgeCore({
      getCurrentPath: () => location.pathname,
      navigate: (path) => navigate(path),
      onDraftUpdated: () => navigate(location.pathname, { replace: true }),
    })
    bridge.connect()
    return () => bridge.disconnect()
  }, [navigate, location.pathname])

  return null
}
```

**Alternative:** If `PreviewBridgeCore` is extracted as a framework-agnostic class (see Nuxt/Astro plans), this becomes trivial. But since React Router is React-based, we could also create a `PreviewBridge` variant that accepts router hooks as props:

```tsx
<PreviewBridge
  useCurrentPath={() => useLocation().pathname}
  useNavigate={() => useNavigate()}
/>
```

### 4. Block Rendering & Image Decoupling
React Router uses React — `@ai-site-editor/blocks` works directly. The only coupling point is `BlockImage`, which currently hard-imports `next/image`.

**Solution: React Context injection (Option B from deep analysis)**

`BlockImage` is used by 8 of 20 block renderers (Hero, Card, CardGrid, Gallery, Carousel, Quote, SiteHeader, TwoColumn). The actual `next/image` features consumed are just `width`, `height`, `sizes`, `priority`, and `loading` — all of which map to native `<img>` attributes. The only thing lost without `next/image` is automatic optimization (WebP, srcset, on-demand resize).

The blocks package introduces an `ImageProvider` context with a plain `<img>` default. Next.js sites inject `NextImage` via provider; non-Next.js sites get the fallback automatically.

```tsx
// Next.js site — layout.tsx (one line to opt into optimization)
import NextImage from "next/image"
import { ImageProvider } from "@ai-site-editor/blocks"
export default function Layout({ children }) {
  return <ImageProvider component={NextImage}>{children}</ImageProvider>
}

// React Router site — nothing needed, <img> fallback works automatically
```

The Vite editor already uses a similar approach (bundler alias to a stub). After this change, the alias can be removed — the context fallback handles it.

See `/Users/yury/.claude/plans/agile-tickling-pebble.md` for the full deep analysis with all four design options evaluated (runtime require, context injection, build-time alias, conditional exports).

```tsx
import { SharedBlockRenderer } from "@ai-site-editor/blocks"

function BlockRenderer({ block }: { block: BlockInstance }) {
  return (
    <div data-block-id={block.id} data-block-type={block.type}>
      <SharedBlockRenderer block={block} />
    </div>
  )
}
```

**Image handling:** `BlockImage` uses `next/image` which won't be available. Needs the same fallback as Astro — detect `next/image` availability and fall back to `<img>` with `loading="lazy"`.

### 5. Page Component Pattern
```tsx
// app/routes/($slug).tsx
import type { LoaderFunctionArgs } from "react-router"
import { useLoaderData } from "react-router"
import { resolveDraft } from "~/lib/draft.server"
import { fetchEditorPage } from "@ai-site-editor/site-sdk"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import { EditorOverlay } from "~/components/EditorOverlay"

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params.slug ?? "home"
  const draft = await resolveDraft(request)

  let page
  if (draft.isEditor) {
    page = await fetchEditorPage(draft.orchestratorUrl, draft.session, draft.siteId, slug)
  } else {
    page = await getPublishedPage(slug)
  }

  if (!page) throw new Response("Not Found", { status: 404 })
  return { page, isEditor: draft.isEditor }
}

export default function Page() {
  const { page, isEditor } = useLoaderData<typeof loader>()

  return (
    <>
      {page.blocks.map((block) => (
        <div key={block.id} data-block-id={block.id} data-block-type={block.type}>
          <SharedBlockRenderer block={block} />
        </div>
      ))}
      {isEditor && <EditorOverlay />}
    </>
  )
}
```

### 6. Publish Integration
React Router apps can use any publish strategy. The simplest is JSON file persistence (same as sample-site):

```tsx
// In createEditorApiHandler config:
import { createJsonFilePublishHandler } from "@ai-site-editor/site-sdk/publish-handlers/json-file"

const handler = createEditorApiHandler({
  getPages: () => readPagesFromJson(),
  getManifest: () => ({ version: 1, blocks: getBlockRegistry() }),
  onPublish: createJsonFilePublishHandler("./content/pages.json"),
})
```

## SDK Audit Results (March 2026)

### Already Framework-Agnostic (no work needed)
| Abstraction | File | Export Path | Status |
|---|---|---|---|
| `PreviewBridgeCore` | `packages/preview-adapter/src/preview-bridge-core.tsx` | `@ai-site-editor/preview-adapter/core` | Pure React, accepts `navigate`/`refresh` callbacks. No Next.js imports. |
| `DraftModeAdapter` + `resolveDraftContextCore()` | `packages/site-sdk/src/draft-context-core.ts` | `@ai-site-editor/site-sdk/draft/core` | Pure function, 2-property adapter interface. |
| `DraftRouteAdapter` + core handlers | `packages/site-sdk/src/draft-routes-core.ts` | `@ai-site-editor/site-sdk/routes/core` | Standard Web API Request/Response. |
| `renderBlocks()` | `packages/site-sdk/src/render-blocks.tsx` | `@ai-site-editor/site-sdk` | Pure React, no Next.js imports. |
| `SharedBlockRenderer` | `packages/blocks/src/renderer.tsx` | `@ai-site-editor/blocks` | Pure React dispatcher. |

### Blockers — Three Next.js Coupling Points

#### Blocker 1: `BlockImage` hard-codes `next/image`
**File:** `packages/blocks/src/blocks/block-image.tsx`

```tsx
import NextImage from "next/image"  // unconditional — breaks without Next.js
```

Every block renderer that shows images goes through `BlockImage`. Without `next/image`, the entire blocks package fails to import.

**Fix: React Context injection.** Introduce `ImageProvider` context in `packages/blocks` with a plain `<img>` default. `BlockImage` reads from context instead of importing `next/image` directly. Next.js sites wrap in `<ImageProvider component={NextImage}>`. Non-Next.js sites get `<img>` fallback with no configuration. Only `width`/`height`/`sizes`/`priority`/`loading` are actually used by blocks — `fill`, `quality`, `placeholder` are never used. See plan file for full analysis of 4 design options.

#### Blocker 2: `createEditorApiHandler` coupled to Next.js context
**File:** `packages/site-sdk/src/editor-api-handler.ts`

Two coupling points:
1. **Signature**: `context: { params: Promise<{ path: string[] }> }` — Next.js App Router convention for extracting route params.
2. **Imports**: `createDraftEnableHandler()` from `draft-routes.ts` which imports `next/headers` and `NextResponse`.

**Fix:** Create `createEditorApiHandlerCore()` in a new file that:
- Takes `(request: Request, path: string)` instead of Next.js context
- Accepts `draftAdapter: () => DraftRouteAdapter` in config
- Export at `@ai-site-editor/site-sdk/routes/core`
- Refactor existing `createEditorApiHandler` as thin Next.js wrapper

#### Blocker 3: `EditorOverlay` uses `next/dynamic`
**File:** `packages/site-sdk/src/editor.ts`

Uses `dynamic(() => import(...), { ssr: false })` for lazy loading. Minor — React Router sites can use `React.lazy()` or import `PreviewBridgeCore` directly.

**Fix:** Export the component directly alongside the Next.js wrapper. React Router sites import `PreviewBridgeCore` and wrap it themselves (~15 lines, shown in code examples above).

## Implementation Plan

### Step 1: Decouple `BlockImage` (packages/blocks)
- Modify `block-image.tsx` to try/catch `require("next/image")`
- Fall back to `<img>` with equivalent `fill`/`loading`/`sizes` behavior
- Verify sample-site and contentful-site still render correctly

### Step 2: Create `createEditorApiHandlerCore` (packages/site-sdk)
- New file `editor-api-handler-core.ts`
- Move routing logic from `editor-api-handler.ts`, accept `(request, path)` + `draftAdapter`
- Refactor `editor-api-handler.ts` to wrap the core
- Export from `@ai-site-editor/site-sdk/routes/core`

### Step 3: Create React Router example site (examples/react-router-site)
- Scaffold with `npx create-react-router@latest`
- Wire editor API via resource route using `createEditorApiHandlerCore`
- Draft session via `createCookieSessionStorage`
- Page route with `loader` + `useLoaderData`
- EditorOverlay using `PreviewBridgeCore` + `useNavigate`/`useLocation`
- Block rendering with `SharedBlockRenderer` (BlockImage falls back to `<img>`)
- JSON file content + `createJsonFilePublishHandler`

### Step 4: Monorepo integration
- Add to pnpm workspace
- Verify `pnpm typecheck` passes across all packages
- Verify existing sites have no regressions

## What the Site Developer Implements
1. Resource route for editor API (`api.editor.$.tsx`) — ~15 lines
2. Draft session cookie setup — ~20 lines
3. Draft context resolver — ~15 lines
4. Page route with loader — ~30 lines
5. Editor overlay component — ~15 lines

**Total integration surface: ~95 lines** (comparable to Next.js integration)

## Effort Estimate
- **SDK changes:** ~1.5 days (BlockImage fallback + EditorApiHandlerCore)
- **Reference React Router site:** ~1-2 days (all React, minimal adaptation)
- **Total:** ~2.5-3.5 days for a working React Router example site

## Priority
**P0** — Smallest gap of any framework. Same React runtime means blocks, preview bridge, and rendering all work with minimal adaptation. Only routing, draft mode, and image primitives differ. This should be the first non-Next.js framework we support.

## Shared SDK Work Across All Frameworks
These SDK changes benefit all three framework plans and should be done once:

| Change | Files | Effort | Benefits |
|--------|-------|--------|----------|
| `BlockImage` with `next/image` fallback | `packages/blocks/src/blocks/block-image.tsx` | 0.5 day | All non-Next.js frameworks |
| `createEditorApiHandlerCore` | `packages/site-sdk/src/editor-api-handler-core.ts` | 1 day | All non-Next.js frameworks |
| `PreviewBridgeCore` (callback-based) | `packages/preview-adapter/src/preview-bridge-core.tsx` | Already done | All frameworks |
| `resolveDraftContextCore` | `packages/site-sdk/src/draft-context-core.ts` | Already done | All frameworks |
| `createDraftEnableHandlerCore` / `Disable` | `packages/site-sdk/src/draft-routes-core.ts` | Already done | All frameworks |
