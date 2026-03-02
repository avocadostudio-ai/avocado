---
allowed-tools: Bash
---

Restart the dev servers for this monorepo.

Steps:
1. Kill any processes on ports 3000, 4100, and 4200 (ignore errors if nothing is running)
2. Run `pnpm dev` in the background from the repo root
3. Wait a few seconds, then verify each server is responding:
   - `curl -sf http://localhost:4200/health` (orchestrator)
   - `curl -sf http://localhost:4100` (editor)
   - `curl -sf http://localhost:3000` (site)
4. Report which servers are up
