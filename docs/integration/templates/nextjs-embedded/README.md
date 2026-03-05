# Next.js Embedded Draft Templates

Entry docs:
- `docs/integration/README.md`
- `docs/integration/nextjs-mvp-embedded.md`

Copy these files into your Next.js app:

- `app/api/draft/helpers.ts`
- `app/api/draft/route.ts`
- `app/api/draft/disable/route.ts`
- `app/api/editor/components/route.ts`
- `lib/draft-content-source.ts`
- `lib/page-data.ts`
- `editor/build-draft-url.ts` (or equivalent editor helper)

Set environment variable:

- `DRAFT_MODE_SECRET`

Then verify:

1. `/api/draft?secret=wrong&redirect=/` returns `401`.
2. `/api/draft?secret=<DRAFT_MODE_SECRET>&redirect=/` sets draft cookie and redirects.
3. `/api/draft/disable?redirect=/` clears draft cookie and redirects.
4. Page data switches by draft cookie state (published when off, draft when on).
5. `/api/editor/components` returns component manifest JSON.

Manifest-first MVP note:
- Structural edits should be enabled only when `/api/editor/components` is available.
- If manifest is missing, keep site in read-only preview or text-only mode.
