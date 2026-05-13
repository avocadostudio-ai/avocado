# strapi-site

Next.js 15 site backed by a self-hosted **Strapi v5** instance, with Avocado
Studio editor integration.

Demonstrates the **split-route** pattern: a fully static published path
plus a dynamic `/preview-draft` path that handles editor and draft mode.

- **Site** (this app): http://localhost:3005
- **Strapi admin**: http://localhost:1337/admin
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

You'll need a Strapi v5 backend. The setup script writes JSON schema files
into a Strapi project directory you provide, so the easiest path is to run a
local Strapi instance alongside.

---

## 2. Create a Strapi project

```bash
# in a separate directory (NOT inside the avocado monorepo)
npx create-strapi@latest strapi-backend --quickstart --skip-cloud --no-run
cd strapi-backend
```

`--quickstart` provisions a SQLite database (zero config). The first time you
run `npm run develop`, Strapi prompts you to create an admin user — do that
and verify you can sign in to http://localhost:1337/admin.

After signing in, **stop Strapi (Ctrl+C)** before the next step. The setup
script writes schema files to disk; Strapi has to be restarted to pick them
up.

---

## 3. Bootstrap content types

The example ships with a one-shot script that generates Strapi schema files
from the Avocado block registry: 20 block components + a `page` collection
type with a Dynamic Zone field + a `site-config` single type.

```bash
STRAPI_PROJECT=/absolute/path/to/strapi-backend pnpm --filter strapi-site strapi:setup
```

Then restart Strapi:

```bash
cd /absolute/path/to/strapi-backend
npm run develop
```

In the admin you should now see:
- **Content-Type Builder → Components → blocks** — 20 components
- **Content-Type Builder → Collection types → Page** — with a `blocks`
  Dynamic Zone field accepting all block components
- **Content-Type Builder → Single types → Site Config**

> **Bringing your own schema?** Skip the script and write your own
> `lib/strapi.fetch.ts` adapter. The setup script is a starter kit, not a
> hard dependency.

---

## 4. Generate an API token

In Strapi admin: **Settings → API Tokens → Create new API Token**:

- **Name**: `avocado-editor`
- **Token duration**: Unlimited (for development)
- **Token type**: **Full access**
- **Save** — copy the token (shown once). This becomes `STRAPI_API_TOKEN`.

The Full-access token is needed because the publish handler creates entries,
uploads media, and writes to single types.

---

## 5. Grant Public read permissions

The published Next.js site reads via the public REST API, so it needs
permissions even though writes go through the token.

In Strapi admin: **Settings → Users & Permissions Plugin → Roles → Public**:

- **Page**: ✅ `find`, ✅ `findOne`
- **Site-config**: ✅ `find`
- **Upload**: ✅ `find`, ✅ `findOne` (so the published site can read media)

Click **Save** at the top. Without this, the live site sees empty pages.

---

## 6. Configure environment

```bash
cp examples/strapi-site/.env.example examples/strapi-site/.env.local
$EDITOR examples/strapi-site/.env.local
```

```
STRAPI_URL=http://localhost:1337
STRAPI_API_TOKEN=<from step 4>
STRAPI_WEBHOOK_SECRET=                         # any string; required only if you set up the webhook (step 9)
ORCHESTRATOR_URL=http://localhost:4200
DRAFT_MODE_SECRET=top-secret                   # any string
```

---

## 7. Run the site

```bash
pnpm --filter strapi-site dev
```

Open:
- http://localhost:3005 — the published site (empty until you create content)
- http://localhost:1337/admin — the Strapi admin, where you can author pages directly

Then open the Avocado **Content Studio** at http://localhost:4100:

1. Click the site picker → **Add site**:
   - **Site ID**: `strapi-site`
   - **Origin**: `http://localhost:3005`
2. Start chatting. Publishing from the editor calls
   `http://localhost:3005/api/editor/publish`, which writes back to Strapi
   via the API token.

---

## 8. (Optional) Protect the publish endpoint

Set `PUBLISH_TOKEN=<some secret>` in `.env.local`. The editor route reads it
and rejects publish requests without a matching `x-publish-token` header.

---

## 9. (Optional) Wire the ISR webhook

Production-only.

In Strapi admin: **Settings → Webhooks → Create new webhook**:

- **Name**: `avocado-revalidate`
- **URL**: `https://<your-deployed-site>/api/revalidate`
- **Headers**: add a custom header
  - **Key**: `x-revalidate-secret`
  - **Value**: same string you set as `STRAPI_WEBHOOK_SECRET`
- **Events**: under **Entry**, check **create**, **update**, **delete**, **publish**, **unpublish**.

The handler validates the secret, calls `revalidatePath()`, and re-bootstraps
the orchestrator.

---

## What's wired up

| File | Role |
|------|------|
| `app/[[...slug]]/page.tsx` | Static published route (`mode: "static"`) |
| `app/preview-draft/[[...slug]]/page.tsx` | Dynamic editor route (`mode: "preview"`) |
| `middleware.ts` | Rewrites editor/draft requests to the preview route |
| `app/api/editor/[...path]/route.ts` | Editor API: blocks, pages, publish, draft |
| `app/api/revalidate/route.ts` | Strapi webhook → ISR + orchestrator bootstrap |
| `lib/strapi.fetch.ts` | CMS adapter — Strapi entries → `PageDoc` / `SiteConfig` |
| `lib/strapi.client.ts` | REST client + `STRAPI_URL` helper |
| `lib/publish.ts` | Publish handler (upserts pages, components, media) |
| `lib/manifest.ts` | Image-field manifest used by the publish handler |
| `scripts/setup-content-types.ts` | One-shot bootstrap (step 3) |

## Key SDK touchpoints

- `createSitePage({ mode: "static" | "preview", ... })` — `@ai-site-editor/site-sdk/page`
- `createEditorMiddleware()` — `@ai-site-editor/site-sdk/middleware`
- `createEditorApiHandler({ getPages, onPublish, publishSecret })` — `@ai-site-editor/site-sdk/routes`
- `createRevalidateHandler({ secretEnvVar, extractSlug, getPages, siteId })` — `@ai-site-editor/site-sdk/routes`
- `lowerToBlockType` — `@avocadostudio-ai/shared`. Strapi component names are
  lowercase (`blocks.faqaccordion`); the registry uses PascalCase (`FAQAccordion`).

## How publish works

The editor sends `{ pages, siteConfig, assets }` to `/api/editor/publish`.
`createStrapiPublishHandler` (in `lib/publish.ts`) then:

1. Uploads inline image assets via `POST /api/upload` and stores returned
   media records.
2. Builds Dynamic Zone entries (`__component: "blocks.<type>"`) from each
   `BlockInstance.props`, mapping image URLs back to media field shapes.
3. Upserts the `page` entry (find-or-create by `slug`) with the Dynamic Zone
   blocks attached.
4. Upserts the singleton `site-config` entry.

Strapi v5 stores all blocks inline in the page's Dynamic Zone — there is no
separate "block entry" content type.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Setup script: `Set STRAPI_PROJECT to the path of your Strapi backend project.` | Missing `STRAPI_PROJECT` env var. Pass an absolute path to your Strapi project root. |
| Strapi admin doesn't show new content types after running setup | Strapi was running while the script wrote the schema files. Stop Strapi (Ctrl+C) and `npm run develop` again. |
| Site shows empty pages | Public role is missing `find`/`findOne` on `Page` (step 5). |
| Images don't load on the published site | Public role is missing permission on `Upload`, OR `STRAPI_URL` doesn't match what your Strapi instance is actually on. |
| Publish fails with `401` / `403` | API token is read-only. Generate a **Full access** token (step 4). |
| `fetch failed` during build | Strapi isn't running on `STRAPI_URL`. Either start Strapi or run `pnpm dev` instead of `pnpm build` (build needs Strapi up to fetch slugs). |
