# `@ai-site-editor/cli` — `avc`

Unified developer CLI for Avocado Studio. Wraps the orchestrator HTTP API so
common workflows (publish, check status, roll back, health check) work from
the terminal without the editor UI.

Product spec: `docs/ideas/avocado-cli.md`.

## Install

The CLI is published to GitHub Packages (not public npm). You will need an
`.npmrc` with a GitHub token that has `read:packages` scope — see
[npmjs auth for GitHub Packages](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

```bash
# in your site's repo, with a configured .npmrc:
pnpm add -D @ai-site-editor/cli
```

Inside the Avocado monorepo, the CLI is already linked as a workspace package —
just run `pnpm exec avc` (or `pnpm --filter @ai-site-editor/cli dev`).

## Commands

### Publishing

| Command | Description |
|---|---|
| `avc publish [--wait] [--timeout <s>]` | Publish the current draft. `--wait` polls `/publish/status` until live or failed |
| `avc status` | Show publish status (Vercel state, deploy URL, inspect URL) |
| `avc diff [--json]` | Show draft vs. published diff |

### History

| Command | Description |
|---|---|
| `avc restore list [--limit <n>] [--json]` | List recent publish snapshots |
| `avc restore commit <sha>` | Roll the draft back to a historical snapshot |

### Onboarding

| Command | Description |
|---|---|
| `avc new` | Scaffold a new integration (delegates to `create-ai-site-editor`) |
| `avc register --name "My Site"` | Register the current Next.js site with the orchestrator |
| `avc sites list [--json]` | List sites registered under the current session |

### Operations

| Command | Description |
|---|---|
| `avc health` | Probe orchestrator, editor, and site. Exits 1 if any are unreachable |
| `avc dev [--site] [--only <list>]` | Start orchestrator + editor (+ optional site) with unified logs. Monorepo-only |

## Common flags

Every command that talks to the orchestrator accepts:

| Flag | Env | Default |
|---|---|---|
| `--orchestrator <url>` | `ORCHESTRATOR_URL` | `http://localhost:4200` |
| `--session <name>` | `AVC_SESSION` | `dev` |
| `--site <id>` | `AVC_SITE_ID` / `NEXT_PUBLIC_DEFAULT_SITE_ID` | _required for most commands_ |
| `--site-origin <url>` | `SITE_ORIGIN` / `NEXT_PUBLIC_SITE_ORIGIN` | _unset_ |
| `--token <token>` | `PUBLISH_TOKEN` | _unset_ |

Values resolve from CLI flags → `process.env` → `.env.local` in the current
directory.

## Examples

```bash
# One-command publish + wait for deploy
avc publish --site my-site --wait

# Show what would change before publishing
avc diff --site my-site

# Find a snapshot to roll back to
avc restore list --site my-site
avc restore commit abc1234 --site my-site

# Check all three services are up
avc health

# Start orchestrator + editor locally (monorepo)
avc dev

# Include the demo site too
avc dev --site
```

## Exit codes

- `0` — success
- `1` — command failed (bad input, orchestrator rejected the request, service down, etc.)

## Architecture

The CLI is a thin wrapper. Every command except `dev`, `new`, and `register`
is a single `fetch` call to the orchestrator:

- `avc publish` → `POST /publish` (+ optional `GET /publish/status` polling)
- `avc status` → `GET /publish/status`
- `avc diff` → `GET /publish/diff`
- `avc restore list` → `GET /restore/snapshots`
- `avc restore commit` → `POST /restore/snapshot`
- `avc sites list` → `GET /sites`
- `avc health` → `GET /health` + editor/site HEAD probes

`avc new` and `avc register` delegate to the existing `create-ai-site-editor`
and `avocado-register` bins via `npx`, so installing `avc` doesn't pull in
their transitive dependencies.

`avc dev` spawns `pnpm --filter <pkg> dev` children with colour-prefixed log
multiplexing and graceful `SIGTERM` shutdown.
