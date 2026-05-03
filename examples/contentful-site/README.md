# contentful-site

Next.js 15 site backed by Contentful, with Avocado Studio editor integration.

Demonstrates the **split-route** pattern: a fully static published path
plus a dynamic `/preview-draft` path that handles editor and draft mode.

- **Site** (this app): http://localhost:3003
- **Content Studio** (editor): http://localhost:4100
- **Orchestrator**: http://localhost:4200

---

## 1. Prerequisites

Before you start, the rest of the stack should be running:

```bash
# from the monorepo root, in a separate terminal
./start                        # boots orchestrator + editor + apps/site
# or, if you've already set up .env at the root:
pnpm dev
```

You'll need a free [Contentful](https://www.contentful.com/sign-up/) account.

---

## 2. Create a Contentful space

1. Sign in to [app.contentful.com](https://app.contentful.com).
2. Click the **+** in the top-left → **Create space** → choose the **Free Community plan** → name it (e.g. `avocado-demo`) → **Confirm and create space**.
3. Inside the new space, go to **Settings (⚙) → General settings**. Copy the **Space ID** — you'll need it as `CONTENTFUL_SPACE_ID`.
4. Stay in **Settings**, switch to **API keys**:
   - Tab **Content delivery / preview tokens** → **Add API key** → name it `avocado-delivery` → save → copy the **Content Delivery API – access token**. This becomes `CONTENTFUL_DELIVERY_TOKEN`.
   - Tab **Content management tokens** → **Generate personal token** → name it `avocado-management` → copy the token (shown once). This becomes `CONTENTFUL_MANAGEMENT_TOKEN`. It carries your full account permissions, so treat it like a password.

---

## 3. Configure environment

```bash
cp examples/contentful-site/.env.example examples/contentful-site/.env.local
$EDITOR examples/contentful-site/.env.local
```

Fill in the values you collected:

```
CONTENTFUL_SPACE_ID=<from step 2.3>
CONTENTFUL_ENVIRONMENT=master                  # leave as-is unless you created a custom environment
CONTENTFUL_DELIVERY_TOKEN=<from step 2.4>
CONTENTFUL_MANAGEMENT_TOKEN=<from step 2.4>
REVALIDATION_SECRET=                           # any string; required only if you set up the webhook (step 7)
ORCHESTRATOR_URL=http://localhost:4200
DRAFT_MODE_SECRET=top-secret                   # any string
```

---

## 4. Bootstrap the content model

The example ships with a one-shot script that creates the full content model:
22 content types (20 block types + `page` + `siteConfig`).

```bash
pnpm --filter contentful-site contentful:setup
```

This needs `CONTENTFUL_SPACE_ID` and `CONTENTFUL_MANAGEMENT_TOKEN` from your
`.env.local`. It is idempotent — re-running it updates existing types in place.

After it completes, refresh the Contentful UI; you should see the new types
under **Content model**.

> **Bringing your own schema?** Skip the script and write your own
> `lib/contentful.ts` adapter that maps your existing types into `PageDoc` /
> `BlockInstance`. The setup script is a starter kit, not a hard dependency.

---

## 5. Run the site

```bash
pnpm --filter contentful-site dev
```

Open http://localhost:3003 — you'll see the published site (empty until you
create content).

Now open http://localhost:4100 (Content Studio). The first time you load it,
add a new site:

1. Click the site picker → **Add site** → enter:
   - **Site ID**: `contentful-site`
   - **Origin**: `http://localhost:3003`
2. Start editing in the chat panel. When you publish, the editor POSTs to
   `http://localhost:3003/api/editor/publish`, which writes back to Contentful
   via the management token.

Alternatively you can author directly in the Contentful web app — the site
re-fetches on every static-build (`pnpm --filter contentful-site build`) and,
in dev, on every request.

---

## 6. (Optional) Protect the publish endpoint

Set `PUBLISH_TOKEN=<some secret>` in `.env.local`. The editor route reads it via
`process.env.PUBLISH_TOKEN` and rejects publish requests without a matching
`x-publish-token` header. Configure the same value on the editor side.

---

## 7. (Optional) Wire the ISR webhook

Production-only. Skips dev — `pnpm dev` rebuilds on every request anyway.

In Contentful: **Settings → Webhooks → Add webhook**:

- **Name**: `avocado-revalidate`
- **URL**: `https://<your-deployed-site>/api/revalidate`
- **Method**: POST
- **Headers**: add a custom header
  - **Key**: `x-revalidate-secret`
  - **Value**: same string you set as `REVALIDATION_SECRET`
- **Triggers**: select **Specify** → for content type **Page**, check **Publish** and **Unpublish**.

The handler in `app/api/revalidate/route.ts` validates the secret, calls
`revalidatePath()`, and re-bootstraps the orchestrator with the fresh content.

---

## What's wired up

| File | Role |
|------|------|
| `app/[[...slug]]/page.tsx` | Static published route (`mode: "static"`) |
| `app/preview-draft/[[...slug]]/page.tsx` | Dynamic editor route (`mode: "preview"`) |
| `middleware.ts` | Rewrites editor/draft requests to the preview route |
| `app/api/editor/[...path]/route.ts` | Editor API: blocks, pages, publish, draft |
| `app/api/revalidate/route.ts` | Contentful webhook → ISR + orchestrator bootstrap |
| `lib/contentful.ts` | CMS adapter — Contentful entries → `PageDoc` / `SiteConfig` |
| `lib/publish.ts` | Transactional publish handler (entries + assets) |
| `lib/manifest.ts` | Image-field manifest used by the publish handler |
| `scripts/setup-content-types.ts` | One-shot bootstrap script (step 4) |

## Key SDK touchpoints

- `createSitePage({ mode: "static" | "preview", ... })` — `@ai-site-editor/site-sdk/page`
- `createEditorMiddleware()` — `@ai-site-editor/site-sdk/middleware`
- `createEditorApiHandler({ getPages, onPublish, publishSecret })` — `@ai-site-editor/site-sdk/routes`
- `createRevalidateHandler({ secretEnvVar, extractSlug, getPages, siteId })` — `@ai-site-editor/site-sdk/routes`
- `getManifestImageFields(manifest)` — `@ai-site-editor/site-sdk/routes` (used by `lib/publish.ts` to walk image fields without hard-coding block types)

## How publish works

The editor sends `{ pages, siteConfig, assets }` to `/api/editor/publish`.
`createContentfulPublishHandler` (in `lib/publish.ts`) then:

1. Uploads inline assets (base64 PNGs from generated images) as Contentful
   Assets, deduping by source URL.
2. Upserts one `block{Type}` entry per `BlockInstance` with deterministic IDs
   (so re-publishes update in place).
3. Resolves `CardGrid.cards` to `blockCard` reference entries with
   per-card deterministic IDs; cleans up trailing cards from previous publishes.
4. Upserts the `page` entry with the ordered block links.
5. Upserts a single `siteConfig` entry keyed by `configKey: "default"`.

Every Contentful write is followed by `publish()` so changes are immediately
visible to the delivery API.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `CONTENTFUL_SPACE_ID and CONTENTFUL_DELIVERY_TOKEN are required` at build time | `.env.local` missing or in the wrong directory. Must be `examples/contentful-site/.env.local`. |
| Setup script: `AccessTokenInvalid` | Wrong token type. The setup script needs the **management** token, not the delivery token. |
| Setup script: 404 | Wrong space ID, or the token belongs to a different organization. |
| Published page shows 404 | Page entry exists in Contentful but is in **Draft**. Publish it (or use the editor's publish button), since the delivery API only returns published entries. |
| Image broken on published page | The image hostname isn't in `next.config.ts` `images.remotePatterns`. The example already includes `images.ctfassets.net`; if you use a custom CDN, add it. |
