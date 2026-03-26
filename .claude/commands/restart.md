---
allowed-tools: Bash, AskUserQuestion
description: "Restart dev servers. Use: /restart (menu), /restart orchestrator, /restart core, /restart sites, /restart all"
---

Restart dev servers. The user may specify which server(s) to restart via `$ARGUMENTS`.

## Server Registry

| Name | Port | Dir | Command |
|------|------|-----|---------|
| orchestrator | 4200 | `/Users/yury/Projects/ai-site-editor` | `pnpm dev:orchestrator` |
| editor | 4100 | `/Users/yury/Projects/ai-site-editor` | `pnpm dev:editor` |
| avocado | 3000 | `/Users/yury/Projects/ai-site-editor` | `pnpm dev:site` |
| villa | 3001 | `/Users/yury/Projects/villa-puravida-web` | `pnpm dev` |
| sample | 3002 | `/Users/yury/Projects/ai-site-editor/examples/sample-site` | `pnpm dev` |
| contentful | 3003 | `/Users/yury/Projects/ai-site-editor/examples/contentful-site` | `pnpm dev` |
| sanity | 3004 | `/Users/yury/Projects/ai-site-editor/examples/sanity-site` | `pnpm dev` |
| strapi | 3005 | `/Users/yury/Projects/ai-site-editor/examples/strapi-site` | `pnpm dev` |
| strapi-backend | 1337 | `/Users/yury/Projects/strapi-backend` | `source ~/.nvm/nvm.sh && nvm use 22 && npm run develop` |

## Behavior

### No arguments → Show interactive menu

If `$ARGUMENTS` is empty, first check which ports are currently active using `lsof`, then present a menu using AskUserQuestion with these options:

```
Which servers to restart?

1. all — Everything (orchestrator, editor, all sites)
2. core — Orchestrator + Editor only (:4200 + :4100)
3. orchestrator — Orchestrator only (:4200)
4. editor — Editor only (:4100)
5. sites — All site servers (:3000-3005)
6. avocado — Avocado site (:3000)
7. villa — Villa site (:3001)
8. sample — Sample site (:3002)
9. contentful — Contentful site (:3003)
10. sanity — Sanity site (:3004)
11. strapi — Strapi site + backend (:3005 + :1337)

Currently running: [list ports that have active processes]
```

Then proceed with the user's choice.

### With arguments → Direct restart

- **`all`**: Kill ALL ports, start ALL servers.
- **`core`**: Restart orchestrator + editor only.
- **`sites`**: Restart all site servers (avocado, villa, sample, contentful, sanity, strapi) but NOT orchestrator/editor.
- **One or more names** (e.g. `orchestrator`, `sanity strapi`): Kill only those ports, restart only those servers.

## Steps

1. Parse `$ARGUMENTS` to determine which servers to restart. If empty, show menu first.
2. Kill processes on the relevant ports only (ignore errors if nothing is running).
3. Start each server in the background from its directory.
   - For `orchestrator`, `editor`, and `avocado`: if restarting all three, use `pnpm dev` from the monorepo root (starts all three). If restarting individually, use the specific command (e.g. `pnpm dev:orchestrator`).
   - For `strapi-backend`: requires Node 22 via nvm.
4. Wait a few seconds, then verify ONLY the restarted servers are responding using curl.
5. Report which servers are up and which failed.

ARGUMENTS: $ARGUMENTS
