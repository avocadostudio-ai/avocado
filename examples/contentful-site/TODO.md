# Contentful Site — TODO

## Site-SDK improvements (move shared logic in)

- [ ] Move navigation helpers (`buildNavItems`, `buildSiteHeaderBlock`, `slugToLabel`) into `site-sdk/navigation` export — currently copy-pasted from `apps/site/lib/navigation.ts`
- [ ] Extract page scaffold into site-sdk factory — draft/static branching, chrome assembly, fallback UI are identical across all 3 sites (~100 LOC boilerplate per site)
- [ ] Add Zod validation at the read boundary — `contentful.ts` trusts raw data with `as unknown as`; should validate against `pageDocSchema` like `apps/site` does

## CMS handler packaging

- [ ] Move `publish-handlers/contentful.ts` out of site-sdk into a separate `@ai-site-editor/contentful` package or keep it in the site repo — shipping CMS-specific code in the SDK couples it to a vendor
- [ ] Evaluate the same for any future CMS handlers (Sanity, Strapi, etc.)

## Publish contract gaps

- [ ] Enrich publish result type — `{ ok: boolean }` doesn't report which pages succeeded/failed; needs per-page status
- [ ] Handle partial publish failures — if page 3/5 fails, pages 1-2 are published with no rollback
- [ ] Add authentication to `POST /api/editor/publish` — endpoint currently accepts any POST from allowed CORS origins; needs a token/secret check

## Production readiness

- [ ] Add caching strategy — every page view hits Contentful API; needs cache headers + stale-while-revalidate + ISR revalidation times
- [ ] Validate Contentful webhook payloads — revalidate route hardcodes `fields.slug["en-US"]`; fragile if locale or payload shape changes
- [ ] Support Contentful Preview API for editor draft mode (separate from orchestrator drafts)
- [ ] Add image/asset management via Contentful Assets API instead of plain URL strings
- [ ] Add pagination for >100 pages (currently hardcoded `limit: 100`)

## Chrome & navigation

- [ ] Make footer configurable — currently hardcoded as a constant in page.tsx; should be editable or stored in CMS
- [ ] Add `buildFooterBlock()` factory symmetric with `buildSiteHeaderBlock()`

## Setup & ops

- [ ] Replace string-matching error detection in setup script with proper API checks
- [ ] Add schema versioning — setup script can't update existing content types if PageDoc shape changes
- [ ] Add runtime schema validation — warn if Contentful content types don't match expected shape
- [ ] Remove real tokens from `.env.example` / git history; use placeholders only

## Testing

- [ ] Add unit tests for Contentful publish handler (mock Management API)
- [ ] Add integration test for the publish contract round-trip
- [ ] Add E2E test: edit in editor → publish → verify entry in Contentful → site renders updated content
