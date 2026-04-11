# contentful-marketing-site — known limitations & follow-ups

This workspace is a validation integration: take Contentful's own marketing
webapp template (contentful/template-marketing-webapp-nextjs) and make it
editable via the AI Site Editor. It proves the integration contract
generalizes beyond examples we wrote ourselves.

## What's implemented

- 11 custom blocks mirroring the template's content types (`CtfHeroBanner`,
  `CtfDuplex`, `CtfInfoBlock`, `CtfCta`, `CtfQuote`, `CtfTextBlock`,
  `CtfPerson`, `CtfProduct`, `CtfBusinessInfo`, `CtfProductTable`, `CtfFooter`).
- Read adapter (`lib/contentful.ts`) that walks each page's polymorphic
  `topSection` + `content[]` + `featuredBlocksCollection` refs and flattens
  them into an ordered `BlockInstance[]`.
- Publish handler (`lib/publish.ts`) that upserts per-block entries, splits
  the flat block list back into `topSection` + `content[]`, and round-trips
  rich-text through a minimal document wrapper.
- Content type provisioning script (`scripts/setup-content-types.ts`) that
  seeds a fresh space with the template's content model and one demo page.
- App Router pages with MUI / Emotion SSR wired through
  `@mui/material-nextjs`.

## Known limitations — accept for MVP

1. **Rich text is flattened to plain text.** Contentful rich-text JSON is
   converted to a plain string on read and wrapped as a single-paragraph
   document on write. Bold/italic/links/lists/multi-paragraph structure is
   lost on any round-trip. Fix: expose rich text as a structured field kind
   in the editor.

2. **HeroBanner position is convention-based on publish.** First
   `CtfHeroBanner` in the flattened block list goes to `page.topSection`,
   everything else goes to `page.content[]`. If the user drags a
   non-HeroBanner block above the HeroBanner, publish still treats the
   HeroBanner as the top section. Fix: track origin slot on each block as
   a hidden prop.

3. **topicProduct features stored as inline JSON** instead of separate
   entries linking to a `feature` content type. Loses referential integrity
   but avoids N+1 entry creation per product.

4. **componentProductTable.products stored as inline JSON** instead of
   entry links to `topicProduct`. Same tradeoff.

5. **componentFooter.menuItems stored as inline JSON** instead of entry
   links to `page`. A linked page's label/href won't auto-update when the
   linked page's slug changes.

6. **i18n / multi-locale stripped.** The template supports multiple locales
   via `next-i18next`; we hardcode `en-US` everywhere. Fix: plumb `locale`
   through the site-sdk draft context.

7. **`@contentful/live-preview` removed.** The template's native Contentful
   inspector/preview UI won't work. Our editor overlay replaces it.

8. **Custom renderers are fresh MUI wrappers, not 1:1 ports.** The template's
   original renderers depend heavily on generated GraphQL types and the
   deprecated `@mui/styles` `makeStyles` API. Porting them verbatim would
   require significant rework; the current `src/blocks/renderers.tsx`
   captures the visual essence (palette-aware, responsive layouts, MUI
   theme) without the legacy coupling.

9. **No automated tests.** Verification is manual (see below).

## Setup — prerequisites

1. Create a fresh Contentful space (free tier works — 12 content types).
2. Generate a Content Delivery API token and a Management API token.
3. Copy `.env.example` to `.env.local` and fill in:
   - `CONTENTFUL_SPACE_ID`
   - `CONTENTFUL_DELIVERY_TOKEN`
   - `CONTENTFUL_MANAGEMENT_TOKEN`
4. Provision the content model + demo page:
   ```bash
   pnpm --filter contentful-marketing-site contentful:setup
   ```

## Manual verification checklist

1. `pnpm --filter contentful-marketing-site dev` → open
   `http://localhost:3004/` → confirm the demo hero + CTA render with MUI
   styling.
2. `pnpm dev:editor` + `pnpm dev:orchestrator` → in the editor, add a site
   with `previewUrl: http://localhost:3004` and open it.
3. Verify the block manifest lists all `Ctf*` custom blocks.
4. Verify the home page loads in the editor iframe with selection overlay.
5. Ask the AI: "Change the hero headline to 'Hello Contentful'". Preview
   should update within a few seconds.
6. Click Publish. Verify:
   - `POST /api/editor/publish` returns `{ ok: true }`.
   - The updated entry shows in the Contentful dashboard.
   - Reloading `http://localhost:3004/` (outside editor mode) shows the new
     headline.

## Deferred work

- Port template's original `ctf-richtext` component to preserve formatting.
- Add `topicProduct` feature refs (proper entry-link arrays).
- Plumb locale through site-sdk and remove the `en-US` hardcoding.
- Add a first-class `siteConfig` content type and wire `getContentfulSiteConfig`
  to it instead of synthesizing from a footer entry.
- Add Contentful webhook documentation to README for ISR revalidation.
