# Framework Support: Nuxt 3 (Vue)

## Framework Characteristics
- Vue 3 + Nitro server engine
- File-based routing with `pages/` and server routes in `server/`
- SSR by default, supports SSG via `nuxi generate`
- No built-in "draft mode" concept — must be implemented via cookies + middleware
- Composables (`useState`, `useCookie`, `useAsyncData`) replace React hooks
- Block rendering requires Vue components, not React

## SDK Abstraction Mapping

### 1. Editor API Routes
**Next.js:** `app/api/editor/[...path]/route.ts` with `createEditorApiHandler()`
**Nuxt:** `server/api/editor/[...path].ts` with `defineEventHandler`

`createEditorApiHandler()` returns `{ GET, OPTIONS, POST }` — standard `Request → Response` handlers. Nuxt's Nitro server uses H3 events, not raw `Request/Response`. Needs a thin adapter.

```ts
// server/api/editor/[...path].ts
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"

const handler = createEditorApiHandler({
  getPages: () => getPublishedPages(),
  getManifest: () => ({ version: 1, blocks: getBlockRegistry() }),
})

export default defineEventHandler(async (event) => {
  const path = event.context.params?.path ?? ""
  const method = event.method
  const url = getRequestURL(event)

  // Convert H3 event to Web Request
  const request = toWebRequest(event)
  const fn = method === "POST" ? handler.POST
           : method === "OPTIONS" ? handler.OPTIONS
           : handler.GET

  const response = await fn(request)
  // Convert Web Response back to H3
  setResponseStatus(event, response.status)
  for (const [k, v] of response.headers) setResponseHeader(event, k, v)
  return response.json()
})
```

**SDK change needed:** `createEditorApiHandler` already returns standard Web API `Response` objects. A `createNuxtEditorHandler()` wrapper in a future `@ai-site-editor/nuxt` package could hide the H3 ↔ Web API conversion.

### 2. Draft Mode
**Next.js:** Built-in `draftMode()` from `next/headers` sets a `__prerender_bypass` cookie.
**Nuxt:** No built-in equivalent. Implement via custom cookie + server middleware.

```ts
// server/middleware/draft.ts
export default defineEventHandler((event) => {
  const session = getCookie(event, "ase-draft-session")
  const siteId = getCookie(event, "ase-draft-site")
  event.context.draft = session ? { session, siteId } : null
})
```

**`DraftModeAdapter` implementation:**
```ts
// composables/useDraftContext.ts
import { resolveDraftContextCore } from "@ai-site-editor/site-sdk/draft/core"

export function useDraftContext() {
  const cookie = useCookie
  return resolveDraftContextCore({
    isDraftMode: Boolean(useCookie("ase-draft-session").value),
    getCookie: (name) => useCookie(name).value ?? undefined,
  })
}
```

**`DraftRouteAdapter` implementation:**
```ts
// server/api/editor/draft.ts
import { handleDraftEnable } from "@ai-site-editor/site-sdk/routes/core"

export default defineEventHandler(async (event) => {
  return handleDraftEnable({
    enableDraftMode: async () => {
      // Set cookies — Nuxt has no draftMode() toggle
    },
    disableDraftMode: async () => {
      deleteCookie(event, "ase-draft-session")
      deleteCookie(event, "ase-draft-site")
    },
    createRedirect: (url, cookies) => {
      for (const c of cookies ?? []) setCookie(event, c.name, c.value, c.options)
      return sendRedirect(event, url.toString())
    },
  })
})
```

### 3. Preview Bridge
**Next.js:** `PreviewBridge` uses `useRouter()`, `usePathname()` from `next/navigation`.
**Nuxt:** Needs a Vue composable wrapping `PreviewBridgeCore`.

```vue
<!-- components/EditorOverlay.vue -->
<script setup>
import { onMounted, onUnmounted } from "vue"
import { PreviewBridgeCore } from "@ai-site-editor/preview-adapter/core"

const router = useRouter()
const route = useRoute()

onMounted(() => {
  const bridge = new PreviewBridgeCore({
    getCurrentPath: () => route.path,
    navigate: (path) => router.push(path),
    onDraftUpdated: () => router.replace(route.fullPath), // force re-render
  })
  bridge.connect()
  onUnmounted(() => bridge.disconnect())
})
</script>
```

**SDK change needed:** Extract `PreviewBridgeCore` as a framework-agnostic class (imperative API, no React hooks). Currently partially exists but is coupled to React lifecycle.

### 4. Block Rendering
**Next.js:** `@ai-site-editor/blocks` provides React components (`HeroBlock`, `CardGridBlock`, etc.).
**Nuxt:** Cannot use React components directly in Vue templates.

**Options (in order of feasibility):**
1. **Web Components wrapper** — Wrap each React block in a custom element using `@lit-labs/react` or manual `createRoot`. Blocks render inside shadow DOM. Works but loses Vue reactivity.
2. **Vue block equivalents** — Rewrite blocks as Vue SFCs. Most faithful integration but doubles maintenance.
3. **Headless block data + Vue templates** — SDK provides typed block data, site provides Vue templates. Lightest SDK surface, most work per site.

**Recommended:** Option 3 for v1 (sites bring their own Vue templates), with a future `@ai-site-editor/blocks-vue` package for shared block renderers.

The `data-block-id` and `data-block-type` attributes are framework-agnostic — Vue templates just need to include them:
```vue
<section :data-block-id="block.id" :data-block-type="block.type">
  <!-- block content -->
</section>
```

### 5. Page Component Pattern
```vue
<!-- pages/[...slug].vue -->
<script setup>
const route = useRoute()
const slug = (route.params.slug as string[])?.join("/") || "home"
const draft = useDraftContext()

const { data: page } = await useAsyncData(`page-${slug}`, async () => {
  if (draft.isEditor) {
    return fetchEditorPage(draft.orchestratorUrl, draft.session, draft.siteId, slug)
  }
  return getPublishedPage(slug)
})
</script>

<template>
  <BlockRenderer v-for="block in page.blocks" :key="block.id" :block="block" />
  <EditorOverlay v-if="draft.isEditor" />
</template>
```

## What Needs to Be Built in the SDK
1. **`PreviewBridgeCore` class** — imperative, no React dependency (partially exists)
2. **`createNuxtEditorHandler()`** — H3 event ↔ Web Request adapter (thin wrapper)
3. **Documentation** — Nuxt integration guide with copy-paste examples

## What the Site Developer Implements
1. Server middleware for draft cookie management
2. Vue block components (or use headless block data)
3. `EditorOverlay.vue` composable wrapping `PreviewBridgeCore`
4. Catch-all API route wiring `createEditorApiHandler`
5. Page component with draft/published content switching

## Effort Estimate
- **SDK changes:** ~2 days (PreviewBridgeCore extraction, Nuxt handler wrapper)
- **Reference Nuxt site:** ~3-4 days (Vue block components, integration wiring)
- **Total:** ~1 week for a working Nuxt example site

## Priority
**P2** — Vue ecosystem is large but the block rendering gap (React → Vue) makes this the highest-effort framework to support. Prioritize after React Router and Astro.
