# Framework Support: WordPress (Headless)

## Framework Characteristics
- PHP-based CMS with a mature built-in REST API (`/wp-json/wp/v2/`)
- Content types: posts, pages, custom post types (CPTs), media, categories, tags
- Gutenberg block editor stores content as annotated HTML (`<!-- wp:heading -->`)
- Classic editor stores content as plain HTML
- Authentication: Application Passwords (WP 5.6+), JWT plugin, or OAuth
- ACF / custom fields exposed via REST when registered with `show_in_rest: true`
- Featured images (post thumbnails) accessible via `?_embed` query parameter
- Yoast SEO / RankMath expose meta fields via REST API
- Widely used as a headless CMS — mature ecosystem of headless WP tooling

## Integration Mode: Headless

WordPress is used as a **headless CMS backend** — content is managed in the WP admin, our Next.js site renders the frontend with our block system. This is the same pattern as the Contentful and Sanity example sites.

```
WordPress Admin (wp-admin)     AI Site Editor
┌─────────────────────┐        ┌─────────────────────────┐
│ Content authoring    │        │ Next.js Site (:3000)    │
│ Media library        │        │  - fetches from WP API  │
│ Custom fields (ACF)  │        │  - renders our blocks   │
│ REST API             │◄──────│  - editor API routes    │
│  /wp-json/wp/v2/*    │        │  - publish writes back  │
└─────────────────────┘        └─────────────────────────┘
                                          │
                               ┌─────────────────────────┐
                               │ Orchestrator (:4200)     │
                               │  - chat planning         │
                               │  - ops engine            │
                               └─────────────────────────┘
                                          │
                               ┌─────────────────────────┐
                               │ Editor (:4100)           │
                               │  - chat UI               │
                               │  - iframe preview        │
                               └─────────────────────────┘
```

## SDK Abstraction Mapping

### 1. Editor API Routes
**Same as Contentful/Sanity** — mount `createEditorApiHandler()` at `/api/editor/[...path]`:

```ts
// app/api/editor/[...path]/route.ts
import { createEditorApiHandler } from "@ai-site-editor/site-sdk/routes"
import { createWordPressPublishHandler } from "../../../../lib/publish"
import { getWordPressPages } from "../../../../lib/wordpress"

export const { GET, POST, OPTIONS } = createEditorApiHandler({
  getPages: () => getWordPressPages(),
  publishSecret: process.env.PUBLISH_TOKEN?.trim() || undefined,
  onPublish: createWordPressPublishHandler({
    siteUrl: process.env.WORDPRESS_URL!,
    username: process.env.WORDPRESS_USERNAME!,
    applicationPassword: process.env.WORDPRESS_APP_PASSWORD!,
  }),
})
```

**No SDK changes needed.**

### 2. Content Mapping: WordPress → PageDoc/BlockInstance

#### Page-Level Mapping (Phase 1 — recommended start)

Treat each WP post/page as a `PageDoc` with a simple block structure:

```ts
// lib/wordpress.ts
import type { PageDoc, BlockInstance } from "@ai-site-editor/shared"

interface WPPost {
  id: number
  slug: string
  title: { rendered: string }
  content: { rendered: string }
  excerpt: { rendered: string }
  modified: string
  featured_media: number
  _embedded?: {
    "wp:featuredmedia"?: Array<{ source_url: string; alt_text: string }>
  }
  yoast_head_json?: { og_title?: string; og_description?: string; og_image?: Array<{ url: string }> }
}

function wpPostToPageDoc(post: WPPost): PageDoc {
  const featuredMedia = post._embedded?.["wp:featuredmedia"]?.[0]
  const yoast = post.yoast_head_json

  const blocks: BlockInstance[] = []

  // Hero block from title + featured image
  if (featuredMedia?.source_url || post.title.rendered) {
    blocks.push({
      id: `wp_hero_${post.id}`,
      type: "Hero",
      props: {
        heading: stripHtml(post.title.rendered),
        subheading: stripHtml(post.excerpt.rendered),
        imageUrl: featuredMedia?.source_url ?? "",
        imageAlt: featuredMedia?.alt_text ?? "",
      },
    })
  }

  // RichText block from post content
  blocks.push({
    id: `wp_content_${post.id}`,
    type: "RichText",
    props: {
      content: post.content.rendered,
    },
  })

  return {
    id: `wp_${post.id}`,
    slug: post.slug === "home" ? "/" : `/${post.slug}`,
    title: stripHtml(post.title.rendered),
    updatedAt: post.modified,
    blocks,
    meta: {
      title: yoast?.og_title ?? stripHtml(post.title.rendered),
      description: yoast?.og_description ?? stripHtml(post.excerpt.rendered),
      ogImage: yoast?.og_image?.[0]?.url,
    },
  }
}
```

This approach:
- Works with both Classic Editor and Gutenberg
- No Gutenberg block parsing needed
- Featured image → Hero block, post content → RichText block
- SEO fields from Yoast/RankMath if available

#### Gutenberg Block Mapping (Phase 2 — richer editing)

Parse Gutenberg block comments for structured editing:

```ts
// WordPress stores blocks as: <!-- wp:heading {"level":2} --><h2>Title</h2><!-- /wp:heading -->
function parseGutenbergBlocks(content: string): BlockInstance[] {
  const blockRegex = /<!-- wp:(\w+\/?\w*)\s*(\{.*?\})?\s*-->([\s\S]*?)<!-- \/wp:\1\s*-->/g
  const blocks: BlockInstance[] = []

  let match
  while ((match = blockRegex.exec(content)) !== null) {
    const [, blockName, attrsJson, innerHTML] = match
    const attrs = attrsJson ? JSON.parse(attrsJson) : {}

    blocks.push({
      id: `wp_gb_${blocks.length}`,
      type: gutenbergToBlockType(blockName), // "core/heading" → "Hero", "core/paragraph" → "RichText"
      props: { ...attrs, content: innerHTML.trim() },
    })
  }

  return blocks
}
```

This enables per-block editing but adds complexity — recommended as Phase 2.

### 3. Fetch Layer

```ts
// lib/wordpress.ts
const WP_URL = process.env.WORDPRESS_URL! // e.g., "https://mysite.wordpress.com"
const PER_PAGE = 100

async function wpFetch<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/${endpoint}`, {
    headers: { "Content-Type": "application/json" },
    next: { revalidate: 60 }, // ISR: revalidate every 60s
  })
  if (!res.ok) throw new Error(`WP API ${res.status}: ${endpoint}`)
  return res.json()
}

export async function getWordPressPages(): Promise<PageDoc[]> {
  // Fetch both pages and posts (configurable)
  const [pages, posts] = await Promise.all([
    wpFetch<WPPost[]>(`pages?per_page=${PER_PAGE}&_embed`),
    wpFetch<WPPost[]>(`posts?per_page=${PER_PAGE}&_embed`),
  ])
  return [...pages, ...posts].map(wpPostToPageDoc)
}

export async function getWordPressPage(slug: string): Promise<PageDoc | null> {
  const results = await wpFetch<WPPost[]>(`pages?slug=${slug}&_embed`)
  if (results.length === 0) {
    const postResults = await wpFetch<WPPost[]>(`posts?slug=${slug}&_embed`)
    if (postResults.length === 0) return null
    return wpPostToPageDoc(postResults[0])
  }
  return wpPostToPageDoc(results[0])
}
```

### 4. Publish / Write-back

```ts
// lib/publish.ts
import type { OnPublishFn } from "@ai-site-editor/site-sdk/routes"
import { getAllBlockMeta } from "@ai-site-editor/shared"

interface WordPressPublishOptions {
  siteUrl: string
  username: string
  applicationPassword: string
}

export function createWordPressPublishHandler(opts: WordPressPublishOptions): OnPublishFn {
  const authHeader = "Basic " + Buffer.from(`${opts.username}:${opts.applicationPassword}`).toString("base64")

  async function wpUpdate(postId: number, fields: Record<string, unknown>) {
    // Determine if it's a page or post (by checking both endpoints)
    for (const type of ["pages", "posts"]) {
      const res = await fetch(`${opts.siteUrl}/wp-json/wp/v2/${type}/${postId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(fields),
      })
      if (res.ok) return res.json()
    }
    throw new Error(`Failed to update WP post ${postId}`)
  }

  return async (pages, config) => {
    const results = await Promise.allSettled(pages.map(async (page) => {
      const wpId = parseInt(page.id.replace("wp_", ""), 10)
      if (isNaN(wpId)) return // skip non-WP pages

      // Reconstruct WP fields from blocks
      const heroBlock = page.blocks.find(b => b.id.startsWith("wp_hero_"))
      const contentBlock = page.blocks.find(b => b.id.startsWith("wp_content_"))

      const fields: Record<string, unknown> = {}
      if (heroBlock) {
        fields.title = heroBlock.props.heading
        fields.excerpt = heroBlock.props.subheading
        // Featured image update requires media upload — handle separately
      }
      if (contentBlock) {
        fields.content = contentBlock.props.content
      }
      if (page.meta) {
        // Yoast SEO fields (if Yoast REST API is available)
        fields.yoast_head_json = {
          og_title: page.meta.title,
          og_description: page.meta.description,
        }
      }

      await wpUpdate(wpId, fields)
      return page.slug
    }))

    const failed = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r, i) => `${pages[i]?.slug}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)

    if (failed.length > 0) {
      return { ok: false, error: `Failed: ${failed.join("; ")}` }
    }
    return { ok: true }
  }
}
```

### 5. Draft Mode
**Same as Contentful/Sanity** — uses Next.js `draftMode()` via `createEditorApiHandler()`.

No WordPress-specific draft mode handling needed. The editor API handler sets the `__prerender_bypass` cookie, and the page component branches between WP fetch (published) and orchestrator fetch (draft).

### 6. Page Component

```tsx
// app/[[...slug]]/page.tsx
import { resolveEditorContext } from "@ai-site-editor/site-sdk"
import { renderBlocks } from "@ai-site-editor/site-sdk/render"
import { fetchEditorPage } from "@ai-site-editor/site-sdk"
import { getWordPressPage, getWordPressPages } from "../../lib/wordpress"

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug: slugParts } = await params
  const slug = slugParts?.join("/") ?? "home"

  const ctx = await resolveEditorContext()

  let page
  if (ctx?.isEditor) {
    page = await fetchEditorPage(ctx.orchestratorUrl, ctx.session, ctx.siteId, slug)
  } else {
    page = await getWordPressPage(slug)
  }

  if (!page) return notFound()

  return (
    <main>
      {renderBlocks(page.blocks, { editable: !!ctx?.isEditor })}
    </main>
  )
}

export async function generateStaticParams() {
  const pages = await getWordPressPages()
  return pages.map((p) => ({
    slug: p.slug === "/" ? undefined : p.slug.replace(/^\//, "").split("/"),
  }))
}
```

### 7. Image Handling

WordPress serves images from its media library (`/wp-content/uploads/`). The image URL is already a direct URL in the REST API response (via `_embedded["wp:featuredmedia"]`), so no special image resolution is needed — unlike Contentful (Asset references) or Sanity (image refs → CDN URL builder).

For publish write-back, uploading new images requires:
```ts
// Upload image to WP media library
async function uploadMedia(imageUrl: string, alt: string): Promise<number> {
  const imageRes = await fetch(imageUrl)
  const blob = await imageRes.blob()
  const res = await fetch(`${siteUrl}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Disposition": `attachment; filename="${alt || "image"}.jpg"`,
      "Content-Type": blob.type,
    },
    body: blob,
  })
  const media = await res.json()
  return media.id
}
```

## Example Project Structure

```
examples/wordpress-site/
  app/
    [[...slug]]/
      page.tsx              — page component (draft/published branching)
    api/
      editor/
        [...path]/
          route.ts          — createEditorApiHandler() wiring
    layout.tsx
  lib/
    wordpress.ts            — WP REST API client, wpPostToPageDoc()
    publish.ts              — createWordPressPublishHandler()
  .env.example              — WORDPRESS_URL, WORDPRESS_USERNAME, WORDPRESS_APP_PASSWORD
  package.json
  next.config.ts
  tsconfig.json
```

## Environment Variables

```bash
# WordPress site URL (no trailing slash)
WORDPRESS_URL=https://mysite.com

# Authentication (Application Passwords — WP 5.6+)
WORDPRESS_USERNAME=admin
WORDPRESS_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Editor publish secret
PUBLISH_TOKEN=your-secret-token

# Optional: custom post types to include (comma-separated)
WORDPRESS_POST_TYPES=posts,pages
```

## What Needs to Be Built

### New: `examples/wordpress-site/` (~315 LOC CMS-specific)
1. `lib/wordpress.ts` — WP REST API client, `wpPostToPageDoc()`, `getWordPressPages()`, `getWordPressPage()` (~120 LOC)
2. `lib/publish.ts` — `createWordPressPublishHandler()` with field mapping and media upload (~130 LOC)
3. `app/api/editor/[...path]/route.ts` — `createEditorApiHandler()` wiring (~13 LOC)
4. `app/[[...slug]]/page.tsx` — page component with draft/published branching (~50 LOC, mostly shared with other examples)

### Shared code to extract first (from CMS integration learnings)
- `getImageFields()` utility — duplicated in Contentful and Sanity, should move to `@ai-site-editor/shared`
- Page component pattern (~113 LOC) — nearly identical across examples, should extract to site-sdk factory

### No SDK/orchestrator/editor changes needed
Everything uses existing contracts: `EditorApiHandlerConfig`, `OnPublishFn`, `PageDoc`, `BlockInstance`, `resolveEditorContext()`.

## WordPress-Specific Considerations

### Authentication
WordPress Application Passwords (built-in since WP 5.6) are the simplest approach:
- Generated in WP Admin → Users → Application Passwords
- Sent as HTTP Basic Auth
- No plugin installation required

Alternative: JWT Authentication plugin for token-based auth (useful for production).

### Custom Post Types
The fetch layer should be configurable to include specific CPTs:
```ts
const postTypes = (process.env.WORDPRESS_POST_TYPES ?? "posts,pages").split(",")
const allContent = await Promise.all(
  postTypes.map(type => wpFetch<WPPost[]>(`${type}?per_page=${PER_PAGE}&_embed`))
)
```

### ACF / Custom Fields
Advanced Custom Fields exposes fields via the REST API when `show_in_rest: true`. These can be mapped to additional block props:
```ts
// ACF fields appear in post.acf
if (post.acf) {
  blocks.push({
    id: `wp_acf_${post.id}`,
    type: "CustomFields",
    props: post.acf,
  })
}
```

### Multisite
WordPress Multisite networks expose per-site REST APIs at `/wp-json/wp/v2/sites/{siteId}/`. The fetch layer can support this by parameterizing the base URL.

### Yoast SEO / RankMath
Both plugins expose SEO metadata via the REST API (`yoast_head_json` or `rank_math` fields). These map to `PageDoc.meta`.

## Comparison to Other Integrations

| Dimension | Contentful | Sanity | **WordPress** |
|---|---|---|---|
| Content model | Structured (typed entries) | Structured (GROQ) | **HTML + optional structured fields** |
| API | REST + GraphQL | GROQ | **REST (built-in)** |
| Auth | API tokens | API tokens | **Application Passwords / JWT** |
| Image handling | Asset references → URL | Image refs → CDN URL | **Direct URLs** |
| Write-back | Management API | Mutations/transactions | **REST PUT + media upload** |
| Custom fields | Content model | Schema | **ACF / custom meta (show_in_rest)** |
| CMS-specific LOC | ~315 | ~315 | **~315 (estimated)** |
| Setup time | ~3-4 hours | ~3-4 hours | **~3-4 hours** |

## Effort Estimate
- **Example site:** ~3-4 hours (following Contentful/Sanity pattern)
- **SDK shared extraction:** ~2 hours (getImageFields + page component factory — benefits all CMS examples)
- **Total:** ~1 day

## Priority
**P1** — WordPress powers ~40% of the web. The headless pattern reuses all existing SDK contracts with zero changes. Lowest effort of any new CMS integration since the WordPress REST API is built-in and well-documented. Natural third example site after Contentful and Sanity.

## Phase 2: Traditional WordPress Site Editing

For editing existing WordPress sites with their own themes (not headless), the approach mirrors the Joomla integration doc (`docs/ideas/framework-joomla.md`):

- **WP Plugin** instead of a PHP system plugin — hooks into `wp_footer` for bridge injection, `the_content` filter for DOM annotation
- **Vanilla JS preview bridge** — same as Joomla plan (`packages/preview-bridge-vanilla/`)
- **Content scanner** — simpler than Joomla since WP REST API already provides structured access to posts, pages, and custom fields
- **Write-back** — WP REST API (vs. Joomla's mix of REST + direct DB)

WordPress's built-in REST API makes the traditional-site path significantly easier than Joomla (~2-3 weeks vs ~3-6 weeks) since the scanner and write-back engine can use the same API as the headless integration.
