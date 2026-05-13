# Publishing `@avocadostudio-ai/blocks` and `@avocadostudio-ai/shared`

These two packages ship to **GitHub Packages** (private to the `avocadostudio-ai` org) so the standalone marketing site at `github.com/avocadostudio-ai/avocadostudio-dev` can render the live block catalogue without forking source.

All other workspace packages (`@ai-site-editor/*`) stay internal — they're not published.

## One-time setup

### Locally (publisher machine)

1. Create a classic GitHub PAT with `write:packages` + `read:packages` scope.
2. Add it to `~/.npmrc`:
   ```
   //npm.pkg.github.com/:_authToken=ghp_xxx
   @avocadostudio-ai:registry=https://npm.pkg.github.com
   ```
3. `npm whoami --registry=https://npm.pkg.github.com` should print your GitHub username.

### Consumer side (marketing repo `avocadostudio-dev`)

1. Create a repo `.npmrc`:
   ```
   @avocadostudio-ai:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```
2. In Vercel project settings → Environment Variables, set `NODE_AUTH_TOKEN` to a PAT with `read:packages` scope (org-scoped recommended). Apply to all environments.
3. `pnpm add @avocadostudio-ai/blocks @avocadostudio-ai/shared` will then resolve.

## Release flow (manual)

From the monorepo root:

```bash
# 1. Bump versions (edit packages/shared/package.json and packages/blocks/package.json)
#    Keep them in lockstep when shared changes affect blocks' public API.

# 2. Build both
pnpm --filter @avocadostudio-ai/shared build
pnpm --filter @avocadostudio-ai/blocks build

# 3. Publish (in dependency order — shared first)
cd packages/shared && pnpm publish --no-git-checks
cd ../blocks && pnpm publish --no-git-checks
```

`--no-git-checks` is needed because we don't tag-per-release. If you adopt git tags
later, drop the flag and let pnpm enforce a clean tree.

## What gets published

- **`shared`** — Zod schemas, block registry, type definitions. Pure TS, no React. Built via `tsc` to `dist/`.
- **`blocks`** — React renderers, `BlockCatalogue`, CSS bundle. Built via `tsc` (which preserves `"use client"` directives as top-of-file string literals) plus a `copy-css.mjs` step that mirrors `src/blocks/**/*.css` into `dist/blocks/`. The `./styles.css` export resolves to `dist/blocks/styles.css` for consumers.

`publishConfig` in each `package.json` rewrites `main`/`types`/`exports` to point at `dist/` only for the published tarball — local workspace consumers still read from `src/`.

## Consumer usage

In the marketing repo:

```tsx
// app/components/page.tsx
"use client"
import { BlockCatalogue } from "@avocadostudio-ai/blocks"
import "@avocadostudio-ai/blocks/styles.css"

export default function ComponentsPage() {
  return <BlockCatalogue />
}
```

And in `next.config.mjs`, add the packages to `transpilePackages` (Next 15 ships them through SWC anyway, but this is safest for the `"use client"` directives + CSS imports):

```js
const nextConfig = {
  transpilePackages: ["@avocadostudio-ai/blocks", "@avocadostudio-ai/shared"],
  reactStrictMode: true,
}
```
