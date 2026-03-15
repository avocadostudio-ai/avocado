# Next.js MVP Adoption Example

This shows a minimal embedded-mode wiring for an existing `app/[[...slug]]/page.tsx` using `@ai-site-editor/site-sdk`.

## Setup

Install the SDK:

```bash
pnpm add @ai-site-editor/site-sdk
```

Create API routes (4 one-liner files):

```
app/api/draft/route.ts              → createDraftEnableHandler()
app/api/draft/disable/route.ts      → createDraftDisableHandler()
app/api/editor/components/route.ts  → createComponentsHandler()
app/api/editor/bootstrap-pages/route.ts → createBootstrapPagesHandler(cb)
```

See [nextjs-mvp-embedded.md](nextjs-mvp-embedded.md) for the full code for each file.

## Example: `lib/content.ts`

```ts
import { fetchDraftPage, fetchDraftSlugs } from "@ai-site-editor/site-sdk"
import { getPublishedPage, getPublishedSlugs } from "./published-content-api"

export async function getPage(slug: string, isDraft: boolean, session: string, siteId: string) {
  if (isDraft) return fetchDraftPage(slug, session, siteId)
  return getPublishedPage(slug)
}

export async function getNavSlugs(isDraft: boolean, session: string, siteId: string) {
  if (isDraft) {
    const slugs = await fetchDraftSlugs(session, siteId)
    if (slugs.length > 0) return slugs
  }
  return getPublishedSlugs()
}
```

## Example: `app/[[...slug]]/page.tsx`

```tsx
import { draftMode } from "next/headers"
import {
  resolveDraftContext, isTileMode, single, buildSlug,
  TileModeStyles, EditorOverlay, getPreviewWrapperProps, BlockErrorBoundary
} from "@ai-site-editor/site-sdk"
import { getPage, getNavSlugs } from "@/lib/content"
import { getPublishedPage } from "@/lib/published-content-api"
import { MyBlockRenderer } from "@/components/block-renderer"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const draft = await draftMode()
  const resolvedParams = await params
  const resolvedSearch = await searchParams
  const slug = buildSlug(resolvedParams.slug)

  // Resolve editor context from search params and cookies
  const editorCtx = await resolveDraftContext(resolvedSearch, {
    defaultSession: "dev",
    defaultSiteId: "my-site"
  })

  const editorMode = draft.isEnabled || !!editorCtx
  const tileMode = editorMode && isTileMode(resolvedSearch)
  const session = editorCtx?.session ?? "dev"
  const siteId = editorCtx?.siteId ?? "my-site"

  // Fetch content — draft from orchestrator, or published from your CMS/filesystem
  const page = await getPage(slug, editorMode, session, siteId)
  if (!page) return <main><h1>Not found</h1></main>

  return (
    <>
      {tileMode && <TileModeStyles />}
      <main>
        {page.blocks.map((block) => (
          <div key={block.id} {...getPreviewWrapperProps(editorMode, block.id, block.type)}>
            <BlockErrorBoundary blockId={block.id} blockType={block.type}>
              <MyBlockRenderer block={block} />
            </BlockErrorBoundary>
          </div>
        ))}
      </main>
      {editorMode && !tileMode && (
        <EditorOverlay slug={slug} editorOrigin={editorCtx?.editorOrigin ?? ""} />
      )}
    </>
  )
}
```

## Editor bootstrap URL (iframe)

Pattern:

```text
${SITE_ORIGIN}/api/draft?secret=${DRAFT_MODE_SECRET}&redirect=${encodeURIComponent(pathWithQuery)}
```

Where `pathWithQuery` includes editor context:

```text
/pricing?session=dev&siteId=my-site
```

Full example:

```text
http://localhost:3000/api/draft?secret=top-secret&redirect=%2Fpricing%3Fsession%3Ddev%26siteId%3Dmy-site
```

## Result

- No required `/preview` route.
- Existing pages stay in place.
- Draft cookie toggles draft vs published data source.
- SDK handler factories provide all API endpoints with zero boilerplate.
- `EditorOverlay` handles PostMessage bridge for editor ↔ site communication.

## Type Mapping Example (Customer Site)

Manifest type IDs must match block model and renderer keys:

```ts
// content blocks from your CMS/store
type Block = { id: string; type: "Hero" | "FeatureGrid"; props: Record<string, unknown> }
```

```ts
// renderer mapping in your Next.js site
const componentByType = {
  Hero: HeroSection,
  FeatureGrid: FeatureGridSection
} as const
```

When manifest + content + renderer share the same type IDs, editor ops stay deterministic.
