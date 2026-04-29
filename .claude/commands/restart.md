---
allowed-tools: Bash, AskUserQuestion
description: "Restart dev servers. Use: /restart (menu), /restart orchestrator, /restart core, /restart sites, /restart all"
---

Restart dev servers. The user may specify which server(s) to restart via `$ARGUMENTS`.

## Server Registry

| Name | Port | Dir | Command |
|------|------|-----|---------|
| orchestrator | 4200 | `<repo-root>` | `pnpm dev:orchestrator` |
| editor | 4100 | `<repo-root>` | `pnpm dev:editor` |
| avocado | 3000 | `<repo-root>` | `pnpm dev:site` |
| widget | 3000 | `<repo-root>` | clears `apps/site/.next`, then `pnpm dev:site` (picks up `@ai-site-editor/immersive-widget` changes) |
| sample | 3002 | `<repo-root>/examples/sample-site` | `pnpm dev` |
| contentful | 3003 | `<repo-root>/examples/contentful-site` | `pnpm dev` |
| sanity | 3004 | `<repo-root>/examples/sanity-site` | `pnpm dev` |
| strapi | 3005 | `<repo-root>/examples/strapi-site` | `pnpm dev` |
| strapi-backend | 1337 | `<sibling: strapi-backend>` (separate clone, outside this repo) | `source ~/.nvm/nvm.sh && nvm use 22 && npm run develop` |
| docs | 5555 | `<repo-root>/docs-site` | `mintlify dev --port 5555` |

## Important: Minimize concurrent servers

Running too many dev servers simultaneously causes EMFILE (too many open files) errors.
Each Next.js site watches the same workspace packages, multiplying file watchers.

- **Default `all`** starts only the core 3 (orchestrator + editor + avocado). NOT all example sites.
- Example/CMS sites (sample, contentful, sanity, strapi) must be started **individually by name**.
- Never start more than 1-2 example sites alongside the core 3.

## Behavior

### No arguments → Show interactive menu

If `$ARGUMENTS` is empty, first check which ports are currently active using `lsof`, then present a menu using AskUserQuestion with these options:

```
Which servers to restart?

1. min — Core + docs (orchestrator + editor + avocado + docs)
2. all — Core stack (orchestrator + editor + avocado)
3. core — Orchestrator + Editor only (:4200 + :4100)
4. orchestrator — Orchestrator only (:4200)
4. editor — Editor only (:4100)
5. avocado — Avocado site (:3000)
6. widget — Clear apps/site/.next + restart avocado (picks up immersive-widget changes)
7. sample — Sample site (:3002)
7. contentful — Contentful site (:3003)
8. sanity — Sanity site (:3004)
9. strapi — Strapi site + backend (:3005 + :1337)
10. docs — Mintlify docs site (:5555)

Currently running: [list ports that have active processes]
```

Then proceed with the user's choice.

### With arguments → Direct restart

- **`min`**: Kill core ports + docs (4200, 4100, 3000, 5555), start orchestrator + editor + avocado + docs.
- **`all`**: Kill core ports (4200, 4100, 3000), start orchestrator + editor + avocado only.
- **`core`**: Restart orchestrator + editor only.
- **`widget`**: Kill port 3000, delete `apps/site/.next`, restart avocado. Use this after editing files in `packages/immersive-widget` — Next.js caches workspace packages and HMR doesn't always pick up changes, so the cache clear is required.
- **One or more names** (e.g. `orchestrator`, `sanity strapi`): Kill only those ports, restart only those servers.

## Steps

1. Parse `$ARGUMENTS` to determine which servers to restart. If empty, show menu first.
2. Kill processes on the relevant ports only (ignore errors if nothing is running).
3. Start each server in the background from its directory.
   - For `orchestrator`, `editor`, and `avocado`: if restarting all three, use `pnpm dev` from the monorepo root (starts all three). If restarting individually, use the specific command (e.g. `pnpm dev:orchestrator`).
   - For `strapi-backend`: requires Node 22 via nvm.
   - **Never auto-start example sites (sample, contentful, sanity, strapi, villa) unless explicitly requested by name.** Each additional Next.js site adds ~1000+ file watchers.
4. Wait a few seconds, then verify ONLY the restarted servers are responding using curl.
5. Report which servers are up and which failed.

ARGUMENTS: $ARGUMENTS
