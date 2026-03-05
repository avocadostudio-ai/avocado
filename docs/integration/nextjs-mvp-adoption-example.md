# Next.js MVP Adoption Example

This shows a minimal embedded-mode wiring for an existing `app/[[...slug]]/page.tsx`.

Assumes you already copied:
- `docs/integration/templates/nextjs-embedded/app/api/draft/*`
- `docs/integration/templates/nextjs-embedded/app/api/editor/components/route.ts`
- `docs/integration/templates/nextjs-embedded/lib/editor-components-contract.ts`
- `docs/integration/templates/nextjs-embedded/lib/site-component-registry.ts`
- `docs/integration/templates/nextjs-embedded/lib/editor-components-manifest.ts`
- `docs/integration/templates/nextjs-embedded/lib/site-contract.ts`
- `docs/integration/templates/nextjs-embedded/lib/draft-content-source.ts`
- `docs/integration/templates/nextjs-embedded/lib/page-data.ts`

## Example: `app/[[...slug]]/page.tsx`

```tsx
import type { Metadata } from "next"
import { loadPageData } from "@/lib/page-data"
import { fetchDraftPage } from "@/lib/draft-api"
import { fetchPublishedPage } from "@/lib/published-api"

type PageProps = {
  params: Promise<{ slug?: string[] }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function toSlug(parts?: string[]) {
  if (!parts || parts.length === 0) return "/"
  return `/${parts.join("/")}`
}

function single(value: string | string[] | undefined) {
  return typeof value === "string" ? value : undefined
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const p = await params
  const q = await searchParams
  const slug = toSlug(p.slug)
  const page = await loadPageData(slug, {
    fetchDraftPage,
    fetchPublishedPage,
    session: single(q.session) ?? "dev",
    siteId: single(q.siteId) ?? "default-site"
  })
  return page ? { title: page.meta?.title ?? page.title } : {}
}

export default async function SitePage({ params, searchParams }: PageProps) {
  const p = await params
  const q = await searchParams
  const slug = toSlug(p.slug)
  const page = await loadPageData(slug, {
    fetchDraftPage,
    fetchPublishedPage,
    session: single(q.session) ?? "dev",
    siteId: single(q.siteId) ?? "default-site"
  })

  if (!page) return <main><h1>Not found</h1></main>

  return (
    <main>
      <h1>{page.title}</h1>
      {/* render your existing blocks/components here */}
    </main>
  )
}
```

## Editor bootstrap URL (iframe)

Use:
- `docs/integration/templates/nextjs-embedded/editor/build-draft-url.ts`

Example:

```ts
const url = buildDraftEntryUrl({
  siteOrigin: "http://localhost:3000",
  draftSecret: "top-secret",
  slug: "/pricing",
  session: "dev",
  siteId: "adventure-atlas"
})
```

## Result

- No required `/preview` route.
- Existing pages stay in place.
- Draft cookie toggles draft vs published data source.
- Local component registry drives `/api/editor/components` manifest.

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
