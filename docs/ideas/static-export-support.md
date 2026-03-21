# Static Export Support (Deferred)

## Context

Next.js `output: "export"` produces pure HTML files deployable to any static host (S3, GitHub Pages, Netlify static) with no Node.js runtime. Currently the sample site does not use it because `output: "export"` is incompatible with API routes in the same app directory.

## Current state

- `generateStaticParams` pre-renders all pages at build time — deployed to Vercel or any Node.js host, these are served as static HTML
- The `app/api/editor/[...path]/` route provides editor integration (block manifest, pages, draft mode) and requires a server
- Both coexist cleanly without `output: "export"`

## Why deferred

- The primary deployment target (Vercel) supports SSG + API routes natively
- `output: "export"` is only needed for dumb file hosts with zero server runtime — a niche use case
- Making it work requires either removing the API route at build time (hacky `mv` script) or maintaining two separate Next.js configs
- Neither approach is clean enough for a reference example

## Trigger conditions

Revisit when:
- An adopter needs to deploy to a static-only host
- Next.js adds support for excluding routes from static export
- A second integration validates the pattern

## Implementation sketch

When needed, the adopter can:
1. Remove `app/api/` directory
2. Add `output: "export"` and `images: { unoptimized: true }` to `next.config.ts`
3. Guard editor imports behind `process.env.STATIC_EXPORT` check in page.tsx
4. Add `"build:static": "STATIC_EXPORT=1 next build"` script

This is a 2-minute deployment-time change, not something the SDK needs to handle.
