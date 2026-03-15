# Next.js Embedded Draft Templates (Legacy Reference)

> **Note:** These template files are kept as reference but are no longer the recommended integration path. Use `@ai-site-editor/site-sdk` instead — it provides handler factories that replace all the boilerplate below with one-liner imports.

## Recommended approach

Install the SDK and use handler factories directly:

```bash
pnpm add @ai-site-editor/site-sdk
```

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

See the main integration docs:
- `docs/integration/README.md`
- `docs/integration/nextjs-mvp-embedded.md`
- `docs/integration/nextjs-mvp-adoption-example.md`

## Legacy template files (reference only)

These files show the manual implementation that the SDK now handles internally:

- `app/api/draft/helpers.ts` — draft mode cookie helpers (now in SDK)
- `app/api/draft/route.ts` — draft enable handler (now `createDraftEnableHandler()`)
- `app/api/draft/disable/route.ts` — draft disable handler (now `createDraftDisableHandler()`)
- `app/api/editor/components/route.ts` — manifest endpoint (now `createComponentsHandler()`)
- `lib/editor-components-contract.ts` — manifest types (now exported from SDK)
- `lib/site-component-registry.ts` — example component registry
- `lib/editor-components-manifest.ts` — manifest builder (now `buildComponentsManifest()` in SDK)
- `lib/site-contract.ts` — type definitions (now `PageDoc`, `BlockInstance` etc. from SDK)
- `lib/draft-content-source.ts` — draft fetching (now `fetchDraftPage()` from SDK)
- `lib/page-data.ts` — page data loading example
- `editor/build-draft-url.ts` — URL helper

Set environment variable:

- `DRAFT_MODE_SECRET`
