# Avocado CLI (`avc`) — Product Idea

_Last updated: 2026-04-22_

## 1. Background & Motivation

Adobe's [Helix CLI](https://github.com/adobe/helix-cli) (`aem`) demonstrates that a compelling developer experience for a CMS/publishing platform requires a first-class CLI — not just a GUI. Its core value: developers never need a browser to scaffold, preview, or publish. One command (`aem up`) starts the whole local environment; `aem content push` ships content.

Avocado Studio already has strong server-side infrastructure:

- **`create-ai-site-editor`** — scaffolds a new Next.js site integration
- **`avocado-register`** (in `@ai-site-editor/site-sdk`) — registers a site with the orchestrator
- **Three pluggable publish targets** — `SiteContractPublishTarget`, `GitPublishTarget`, `DeployHookPublishTarget`
- **REST API** for publish, diff, restore, and status — fully functional, just not exposed via CLI

The gap: none of this is accessible without the editor UI or manual `curl`. Developers who expect a `<tool> publish` workflow have no path.

## 2. Goal

Ship a single `avc` binary that makes every core Avocado workflow available from the terminal, requiring no browser and no manual HTTP calls.

## 3. Command Surface

### Phase 1 — Core (MVP)

| Command | What it does | Underlying |
|---|---|---|
| `avc new` | Interactive scaffolder — CMS choice, site ID, block type | `create-ai-site-editor` |
| `avc register` | Register a site with the orchestrator, write `.env.local` | `avocado-register` / `POST /sites/register` |
| `avc dev` | Start orchestrator + editor + site with unified log output | Spawns child processes |
| `avc publish` | Publish current draft to the configured target | `POST /publish` |
| `avc status` | Show current publish status (Vercel state, deploy URL) | `GET /publish/status` |

```bash
# Scaffold a new site
avc new

# Register with a running orchestrator
avc register --name "Marketing Site" --port 3000

# Start the whole stack (orchestrator + editor + your Next.js site)
avc dev

# Publish the draft for session "dev"
avc publish --session dev --site my-site

# Wait for deployment to complete and print the live URL
avc publish --session dev --site my-site --wait

# Check publish status
avc status --session dev --site my-site
```

### Phase 2 — Content & History

| Command | What it does | Underlying |
|---|---|---|
| `avc diff` | Show what would change if published (draft vs. published) | `GET /publish/diff` |
| `avc restore list` | List available git snapshots | `GET /restore/snapshots` |
| `avc restore --commit <sha>` | Roll back to a historical snapshot | `POST /restore/snapshot` |

```bash
# See what's changed before publishing
avc diff --session dev --site my-site

# List restore points
avc restore list --site my-site

# Roll back to a specific commit
avc restore --commit abc1234 --session dev --site my-site
```

### Phase 3 — Operations

| Command | What it does |
|---|---|
| `avc health` | Ping orchestrator, editor, and site; report which are up |
| `avc logs` | Tail logs from any running service (`--service site\|editor\|orchestrator`) |
| `avc sites list` | List all sites registered with the orchestrator |
| `avc config get/set` | Read/write CLI config (orchestrator URL, default session, etc.) |

## 4. `avc dev` — Unified Dev Server

The most user-facing command. Helix's `aem up` is a single-command dev server; `avc dev` does the equivalent for our three-service architecture.

**Behaviour:**
1. Reads `.env.local` (or the `--env` flag) to locate `ORCHESTRATOR_URL`, `NEXT_PUBLIC_EDITOR_ORIGIN`, and the site's port.
2. Spawns three child processes: Next.js site, Fastify orchestrator, Vite editor.
3. Multiplexes their stdout/stderr with colour-coded prefixes (`[site]`, `[orchestrator]`, `[editor]`).
4. Prints a ready banner with URLs once all three are listening.
5. Graceful shutdown on `Ctrl-C` (SIGTERM all children, wait for exit).

```
$ avc dev

  ✦ Avocado Studio — local dev

  [orchestrator] Fastify listening on http://localhost:4200
  [editor]       Vite dev server on  http://localhost:4100
  [site]         Next.js ready on    http://localhost:3000

  Open the editor: http://localhost:4100
  Press Ctrl-C to stop.

[site]         GET /          200 in 12ms
[orchestrator] POST /chat     planning...
[editor]       HMR update
```

## 5. `avc publish` — CLI Publishing

Thin wrapper around `POST /publish`. Key flags:

| Flag | Default | Description |
|---|---|---|
| `--session` | `dev` | Orchestrator session name |
| `--site` | from `.env.local` `NEXT_PUBLIC_DEFAULT_SITE_ID` | Site ID |
| `--orchestrator` | from `ORCHESTRATOR_URL` or `http://localhost:4200` | Orchestrator URL |
| `--wait` | off | Poll `GET /publish/status` until `status === "live"` or error |
| `--timeout` | `120` | Seconds before `--wait` gives up |

Exit codes: `0` = success, `1` = publish error, `2` = timeout.

## 6. Configuration

The CLI reads config from (in precedence order):

1. CLI flags
2. Environment variables (`ORCHESTRATOR_URL`, `AVC_SESSION`, `AVC_SITE_ID`)
3. `.env.local` in the current directory
4. `~/.config/avocado/config.json` (global defaults)

No new config format is introduced — the existing `.env.local` convention used by `avocado-register` is the source of truth.

## 7. Implementation Plan

### Package

New package: `packages/cli` → published as `@ai-site-editor/cli`, bin `avc`.

```
packages/cli/
  src/
    commands/
      new.ts          # wraps create-ai-site-editor
      register.ts     # wraps avocado-register
      dev.ts          # process manager
      publish.ts      # POST /publish + optional poll
      status.ts       # GET /publish/status
      diff.ts         # GET /publish/diff
      restore.ts      # GET + POST /restore/snapshot
      health.ts
    config.ts         # reads env + .env.local
    http.ts           # fetch wrapper with retry + auth
    index.ts          # CLI entrypoint (yargs or commander)
  package.json
  tsconfig.json
```

### Dependencies

- **`commander`** or **`yargs`** — argument parsing
- **`@clack/prompts`** — already used by `create-ai-site-editor`, consistent UX
- **`execa`** — child process management for `avc dev`
- No new runtime dependencies for `publish`, `status`, `diff`, `restore` — pure `fetch` calls

### Build order

1. `avc publish` and `avc status` — zero new infrastructure, highest day-to-day value
2. `avc diff` and `avc restore` — pure API wrappers
3. Migrate `create-ai-site-editor` → `avc new` and `avocado-register` → `avc register`
4. `avc dev` last — process management is the most complex piece

## 8. Comparison with Helix CLI

| Capability | Helix CLI (`aem`) | Avocado CLI (`avc`) |
|---|---|---|
| Scaffold new project | `aem import` (content-focused) | `avc new` (app integration) |
| Local dev server | `aem up` | `avc dev` |
| Publish content | `aem content push` (to da.live) | `avc publish` (git / Vercel / site contract) |
| Show diff | `aem content diff` | `avc diff` |
| Content versioning | `aem content clone/commit/status` | `avc restore list/restore` |
| Authentication | site token (header) | `PUBLISH_TOKEN` env var |
| Plugin system | none | none (phase 3 consideration) |
| Target infra | Adobe EDS / da.live only | Git, Vercel, or any HTTP endpoint |

Key difference: Helix is tightly coupled to Adobe's cloud. `avc` is infrastructure-agnostic — the publish target registry already supports git, Vercel deploy hooks, and any site that implements the publish contract.

## 9. Open Questions

- **Binary name**: `avc` vs. `avocado` — `avc` is shorter; `avocado` is clearer for first-time users.
- **`avc dev` scope**: Should it manage the user's own Next.js site, or only the orchestrator + editor (leaving `pnpm dev` in their site to the user)?
- **Auth for publish**: Should `avc publish` automatically inject `x-publish-token` from `.env.local`, or require explicit `--token` flag?
- **`avc new` vs. keeping `create-ai-site-editor` separate**: `npx create-ai-site-editor` follows the standard `npm init` pattern; we may want to keep both.

## 10. Status & Next Steps

_Implementation landed in `packages/cli/` across phases 0-4. What's shipped, and what's still pending._

### Shipped (phases 0-4)

- `avc publish [--wait]`, `avc status`, `avc diff` — thin wrappers over `/publish`, `/publish/status`, `/publish/diff`
- `avc restore list`, `avc restore commit <sha>` — snapshot listing + roll-back via `/restore/snapshots` and `/restore/snapshot`
- `avc health` — probes orchestrator, editor, and site with timeout; non-zero exit if any are down
- `avc new`, `avc register` — delegate to sibling workspace packages via package-local `tsx`, with `npx` fallback + clear GitHub-Packages auth error
- `avc sites list` — lists registered sites from `/sites`
- `avc dev [--site] [--only <list>]` — multiplexes `pnpm --filter` children with colour-coded prefixes and two-stage Ctrl-C shutdown (SIGTERM → SIGKILL)
- Dev bin wrapper at `packages/cli/bin/avc.mjs` so `pnpm exec avc` works in-monorepo without a build step
- 18 unit tests covering `parseEnvFile`, `resolveConfig` precedence, `request` (query stripping, token-header gating, HttpError vs. network error), and `formatRelative`

### Pending — blockers before broad rollout

1. **CI job for the CLI package.** Today only Vercel's preview check runs on CLI PRs. Add a workflow step that runs `pnpm --filter @ai-site-editor/cli typecheck` and `pnpm --filter @ai-site-editor/cli test` on every PR so regressions surface before merge.
2. **Publish the binary.** `@ai-site-editor/cli` is in the workspace with `publishConfig.registry = npm.pkg.github.com` but has never been published. Wire up the release flow (tag-triggered or manual dispatch) and confirm the `dist/index.js` bin + shebang work end-to-end from a fresh install.
3. **External-mode `avc dev`.** Currently spawns `pnpm --filter` children, which only resolves inside the monorepo. For users of an installed `@ai-site-editor/cli`, we'd need orchestrator + editor as separately installable npm packages — or a Docker image — before `avc dev` is useful outside the repo. Call this out in the README until that's sorted.

### Pending — nice-to-have followups

4. **`restore list` session scoping.** The orchestrator route (`GET /restore/snapshots`) accepts only `limit` + `siteId`; the git-grep in `listRestoreSnapshots` does filter by the scoped-session commit-message format but ignores session-name specifically. If a site has multiple sessions, snapshots mix. Add `session` to the query param on the orchestrator, then update the CLI.
5. **`avc logs`.** Sketched in the original spec (phase 3); deferred. Would tail logs from `scripts/devctl.sh` log files or from running `avc dev` children.
6. **`avc config get/set`.** Also sketched; deferred. Would write to `~/.config/avocado/config.json` for global defaults (orchestrator URL, session, site ID).
7. **`avc sites remove`.** `GET /sites` exists; there's no CLI-equivalent for `DELETE /sites/:id` yet. Mirror it once the orchestrator route exists.
8. **Telemetry / error reporting.** Currently the CLI prints errors locally and exits. Consider emitting structured events to the orchestrator so failed-publish metrics aggregate with UI-triggered publishes.
9. **Cross-platform smoke.** All process-management in `avc dev` uses POSIX signals. Verify on Windows (SIGTERM semantics differ; spawn likely needs `shell: true` for `pnpm`).

### Won't-do (yet)

- **Plugin system.** Helix doesn't have one either; not needed until we have third parties asking for extension points.
- **Offline content editing** (Helix's `aem content clone/commit/status`). The Avocado model is chat-first with server-authoritative state; dragging git semantics onto content would complicate more than it simplifies.
