# contentful-marketing-site (WIP)

> **Status: work in progress, not finished.** This example is being actively
> adapted and is not yet ready for general use. Known limitations are tracked
> in [`TODO.md`](./TODO.md). Use [`examples/contentful-site`](../contentful-site)
> for the supported, finished Contentful integration.

## What this is

A clone of Contentful's official marketing template,
[`contentful/template-marketing-webapp-nextjs`](https://github.com/contentful/template-marketing-webapp-nextjs),
adapted to make its content editable through Avocado Studio.

The point is **validation, not novelty**: we're taking a real Contentful
project that already exists in the wild — one we didn't author and didn't
design our integration contract around — and bending it to fit. If our SDK
contract holds up here, it generalises beyond examples we wrote ourselves.

```
contentful/template-marketing-webapp-nextjs   ← upstream, unmodified content model
                    │
                    ▼
       custom Cft* block types in
       src/blocks/ wrap Contentful's
       content types into BlockInstance
                    │
                    ▼
       lib/contentful.ts (read)
       lib/publish.ts   (write — transactional)
                    │
                    ▼
            Avocado Studio editor
```

## Why it's WIP

The upstream template uses content shapes the SDK doesn't model end-to-end yet:

- **Rich text round-trips lose formatting** — Contentful rich-text JSON is
  flattened to a plain string on read and wrapped as a single-paragraph
  document on write. Bold/italic/links/lists/multi-paragraph structure is
  lost on any edit.
- **Polymorphic page sections** (`topSection` + `content[]` +
  `featuredBlocksCollection`) are flattened into a single ordered
  `BlockInstance[]` for editing, then split back on publish. The split is
  positional and brittle.
- **Custom Cft\* block renderers** mirror the upstream content types but
  haven't been audited for prop completeness or styling parity.

See [`TODO.md`](./TODO.md) for the full list.

## Running it

```bash
# from the monorepo root
pnpm install
pnpm dev:contentful-marketing       # runs on :3004
```

You'll need a Contentful space with the marketing template's content model.
Bootstrap a fresh space from `scripts/setup-content-types.ts`:

```bash
CONTENTFUL_SPACE_ID=<id> \
CONTENTFUL_MANAGEMENT_TOKEN=<token> \
pnpm --filter contentful-marketing-site contentful:setup
```

Then point the running app at it via the standard Contentful env vars
(`CONTENTFUL_SPACE_ID`, `CONTENTFUL_DELIVERY_TOKEN`,
`CONTENTFUL_MANAGEMENT_TOKEN`).

## Contributing

If you're picking this up: start with the rich-text round-trip in
`lib/rich-text.ts` — that unblocks the largest set of edits. After that,
the polymorphic-section split in `lib/publish.ts` is the next ergonomics
cliff.
