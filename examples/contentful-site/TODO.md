# Contentful Site — TODO

## Done

- [x] Move Contentful publish handler out of site-sdk into site repo (`lib/publish.ts`)
- [x] Structured content model — one content type per block with native fields
- [x] Image fields as Contentful Assets (Media)
- [x] CardGrid.cards as Array of blockCard entry references
- [x] Publish authentication via `publishSecret` + `x-publish-token` header
- [x] Partial publish failure reporting via `Promise.allSettled`
- [x] Asset dedup cache within a publish
- [x] Re-sync from CMS on editor open + manual sync button
- [x] Webhook handler re-bootstraps orchestrator for auto-refresh
- [x] Zod validation at read boundary removed (using type guards instead — CMS data is trusted after structured content types enforce schema)

## Known Issues (acceptable for example project)

- **CardGrid.cards hardcoded in 3 places** — `contentful.ts`, `publish.ts`, `setup-content-types.ts` all special-case this one block type. If a second block with reference lists is added, all three files need updating. Fix: derive from block metadata.
- **No pagination** — `limit: 100` hardcoded in read layer. Breaks silently at 101+ pages.
- **Placeholder assets for non-http URLs** — relative paths (e.g., `/hero-generated.svg`) create placehold.co assets in Contentful. Should skip non-http URLs or store as plain strings.
- **Asset dedup by title** — `ensureAsset` searches by title (image URL) which isn't a unique key. Could create duplicates if titles collide.
- **No orphan cleanup** — deleted blocks remain as unpublished entries in Contentful forever.
- **Hardcoded locale "en-US"** — webhook handler and publish handler assume en-US. Breaks for multi-locale sites.
- **Hardcoded session/siteId defaults** — `"dev"` / `"contentful-site"` in page.tsx and revalidate handler. Not configurable per environment.
- **Footer hardcoded in page.tsx** — not editable or stored in CMS.
- **No error boundary** — `renderBlocks()` exceptions crash the page with a server error.
- **String-matching error detection in setup script** — checks for "NotFound" in error messages; fragile if SDK changes error format.
- **Per-page publish status not exposed** — result is `{ ok, error }` not `{ ok, pages: [{ slug, ok }] }`.

## Future Improvements

### Before adding more CMS integrations
- [ ] Move navigation helpers to `site-sdk/navigation` — currently duplicated in `apps/site` and `examples/contentful-site`
- [ ] Document or extract page component scaffold — ~115 LOC of identical draft/static branching per site

### Production readiness
- [ ] Add caching strategy (cache headers, stale-while-revalidate, ISR revalidation times)
- [ ] Support Contentful Preview API for draft content (separate from orchestrator drafts)
- [ ] Add pagination for >100 pages
- [ ] Parameterize locale (from env var or site config)
- [ ] Make footer configurable (fetch from CMS or config)
- [ ] Add error boundaries around block rendering
- [ ] Schema versioning for setup script (handle PageDoc shape changes)
- [ ] Runtime schema validation (warn if Contentful content types drift from expected shape)

### Testing
- [ ] Unit tests for publish handler (mock Management API)
- [ ] Integration test for publish contract round-trip
- [ ] E2E test: edit → publish → verify in Contentful → site renders
