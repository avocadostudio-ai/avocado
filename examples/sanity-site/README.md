# sanity-site

Next.js 15 site backed by Sanity, with an embedded Sanity Studio at
`/studio` and Avocado Studio editor integration.

Demonstrates the **split-route** pattern: a fully static published path
plus a dynamic `/preview-draft` path that handles editor and draft mode.

- **Site** (this app): http://localhost:3004
- **Embedded Sanity Studio**: http://localhost:3004/studio
- **Content Studio** (Avocado editor): http://localhost:4100
- **Orchestrator**: http://localhost:4200

---

## 1. Prerequisites

```bash
# from the monorepo root, in a separate terminal
./start                        # boots orchestrator + editor + apps/site
# or, if you've already set up .env at the root:
pnpm dev
```

You'll need a free [Sanity](https://www.sanity.io/login/sign-up) account.

---

## 2. Create a Sanity project

1. Sign in to [sanity.io/manage](https://www.sanity.io/manage).
2. **Create new project** → name it (e.g. `avocado-demo`) → keep the default `production` dataset → **Public** is fine for development.
3. From the project dashboard copy the **Project ID** — it's the short slug shown at the top. This becomes `NEXT_PUBLIC_SANITY_PROJECT_ID`.
4. Open **API → CORS origins → Add CORS origin**:
   - **Origin**: `http://localhost:3004`
   - **Allow credentials**: ✅ on
   - Repeat for any other host you'll embed Studio under.
5. Open **API → Tokens → Add API token**:
   - **Name**: `avocado-editor`
   - **Permissions**: **Editor** (read + write — needed for both publishing from the editor *and* the embedded Studio).
   - Copy the token. It's shown once. This becomes `SANITY_API_TOKEN`.

---

## 3. Configure environment

```bash
cp examples/sanity-site/.env.example examples/sanity-site/.env.local
$EDITOR examples/sanity-site/.env.local
```

```
NEXT_PUBLIC_SANITY_PROJECT_ID=<from step 2.3>
NEXT_PUBLIC_SANITY_DATASET=production           # leave as-is unless you renamed the dataset
SANITY_API_TOKEN=<from step 2.5>
SANITY_WEBHOOK_SECRET=                          # any string; required only if you set up the webhook (step 7)
ORCHESTRATOR_URL=http://localhost:4200
DRAFT_MODE_SECRET=top-secret                    # any string
```

`NEXT_PUBLIC_*` vars are exposed to the browser (the embedded Studio needs
them). The token is server-only.

---

## 4. Generate Sanity schemas

The example ships with the schemas pre-generated under `sanity/schemas/` — you
can skip this step on first run. Re-run only after upgrading the Avocado
block registry or modifying block fields:

```bash
pnpm --filter sanity-site sanity:schema-gen
```

This walks the block manifest and writes one Sanity document schema per block
type to `sanity/schemas/blocks/<block>.ts`, plus an `index.ts`. Studio loads
these via `sanity/sanity.config.ts`.

---

## 5. Run the site

```bash
pnpm --filter sanity-site dev
```

Open:
- http://localhost:3004 — the published site (empty until you create content)
- http://localhost:3004/studio — the embedded Sanity Studio. The first load asks you to authenticate with Sanity. After that, you can author content directly.

Then open the Avocado **Content Studio** at http://localhost:4100:

1. Click the site picker → **Add site**:
   - **Site ID**: `sanity-site`
   - **Origin**: `http://localhost:3004`
2. Start chatting. Publishing from the editor writes documents back to your
   Sanity dataset using the API token.

You can edit content in either Studio or the Avocado editor — both write to
the same dataset.

---

## 6. (Optional) Protect the publish endpoint

Set `PUBLISH_TOKEN=<some secret>` in `.env.local`. The editor route reads it
and rejects publish requests without a matching `x-publish-token` header.
Configure the same value on the editor side.

---

## 7. (Optional) Wire the ISR webhook

Production-only.

In Sanity: **sanity.io/manage → your project → API → Webhooks → Create webhook**:

- **Name**: `avocado-revalidate`
- **URL**: `https://<your-deployed-site>/api/revalidate?secret=<SANITY_WEBHOOK_SECRET>`
- **Trigger on**: ✅ Create, ✅ Update, ✅ Delete
- **Filter** (GROQ): `_type == "page"`
- **Secret**: leave blank (Sanity's secret field signs the body for HMAC; this
  example uses a simpler shared-secret-in-query approach. If you'd rather use
  the signed payload, edit `app/api/revalidate/route.ts` to verify the
  `sanity-webhook-signature` header).

The handler accepts the secret from either `?secret=<…>` or
`x-sanity-webhook-secret`, validates it against `SANITY_WEBHOOK_SECRET`,
calls `revalidatePath()`, and re-bootstraps the orchestrator.

---

## What's wired up

| File | Role |
|------|------|
| `app/[[...slug]]/page.tsx` | Static published route (`mode: "static"`) |
| `app/preview-draft/[[...slug]]/page.tsx` | Dynamic editor route (`mode: "preview"`) |
| `middleware.ts` | Rewrites editor/draft requests to the preview route |
| `app/studio/[[...tool]]/page.tsx` | Embedded Sanity Studio |
| `app/api/editor/[...path]/route.ts` | Editor API: blocks, pages, publish, draft |
| `app/api/revalidate/route.ts` | Sanity webhook → ISR + orchestrator bootstrap |
| `lib/sanity.fetch.ts` | CMS adapter — Sanity docs → `PageDoc` / `SiteConfig` |
| `lib/sanity.client.ts` | Sanity client setup (read + write) |
| `lib/sanity.queries.ts` | GROQ queries for pages and site config |
| `lib/sanity.image.ts` | Asset ref → URL helper |
| `lib/publish.ts` | Publish handler (creates/patches docs in a single transaction) |
| `lib/manifest.ts` | Image-field manifest used by the publish handler |
| `sanity/schemas/` | Generated document schemas (page, blocks/*, siteConfig) |
| `sanity/sanity.config.ts` | Studio configuration (basePath `/studio`) |
| `sanity/schema-gen.ts` | Regenerator for `schemas/blocks/` (step 4) |

## Key SDK touchpoints

- `createSitePage({ mode: "static" | "preview", ... })` — `@ai-site-editor/site-sdk/page`
- `createEditorMiddleware()` — `@ai-site-editor/site-sdk/middleware`
- `createEditorApiHandler({ getPages, onPublish, publishSecret })` — `@ai-site-editor/site-sdk/routes`
- `createRevalidateHandler({ secretEnvVar, secretHeader, extractSlug, getPages, siteId })` —
  `@ai-site-editor/site-sdk/routes`. Sanity's webhooks send the secret as a query param,
  so this example sets `secretHeader: ["query:secret", "x-sanity-webhook-secret"]`.
- `camelToBlockType` / `blockTypeToCamel` — `@avocadostudio-ai/shared`. Sanity's `_type`
  is camelCase (`faqAccordion`); the registry uses PascalCase (`FAQAccordion`).

## How publish works

The editor sends `{ pages, siteConfig, assets }` to `/api/editor/publish`.
`createSanityPublishHandler` (in `lib/publish.ts`) then:

1. Uploads inline image assets to Sanity's asset library and stores their refs.
2. Builds one document per block — `_id` of the form `block-<id>`, `_type`
   derived from the block type — with image URLs converted back to asset refs.
3. Builds the `page` doc (`_id: page-<slug>`) referencing the block docs in order.
4. Builds the `siteConfig` doc. Note that Sanity stores `Record<string, X>`
   shapes as arrays of `{ key, value }` pairs so they're editable in Studio;
   `lib/sanity.fetch.ts` transforms them back at the read boundary.
5. Submits everything in **one transaction** — the publish is all-or-nothing.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Studio at `/studio` shows "CORS error" | Add `http://localhost:3004` to the project's CORS origins (step 2.4). |
| Studio at `/studio` shows "Insufficient permissions" | Token is missing the **Editor** permission. Regenerate (step 2.5). |
| Site shows empty or 404 for known content | Dataset is `private` and the public delivery client can't read it. Either set the dataset to **Public** in sanity.io/manage, or the token already covers reads — no change needed. Also verify `NEXT_PUBLIC_SANITY_DATASET` matches the dataset name. |
| Publish fails with `Unauthorized` | `SANITY_API_TOKEN` is missing or has read-only permission. Use an **Editor** token. |
| Image broken on published page | The image's CDN hostname isn't in `next.config.ts` `images.remotePatterns`. The example already includes `cdn.sanity.io`; if you use external images, add their hosts. |
