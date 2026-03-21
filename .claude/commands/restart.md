---
allowed-tools: Bash
---

Restart the dev servers for this monorepo, the villa site, and the sample site.

Steps:
1. Kill any processes on ports 3000, 3001, 3002, 4100, and 4200 (ignore errors if nothing is running)
2. Run `pnpm dev` in the background from the repo root (`/Users/yury/Projects/ai-site-editor`)
3. Run `pnpm dev` in the background from the villa site (`/Users/yury/Projects/villa-puravida-web`)
4. Run `pnpm dev` in the background from the sample site (`/Users/yury/Projects/ai-site-editor/examples/sample-site`)
5. Wait a few seconds, then verify each server is responding:
   - `curl -sf http://localhost:4200/health` (orchestrator)
   - `curl -sf http://localhost:4100` (editor)
   - `curl -sf http://localhost:3000` (avocado site)
   - `curl -sf http://localhost:3001` (villa site)
   - `curl -sf http://localhost:3002` (sample site)
6. Report which servers are up
