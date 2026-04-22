# `@ai-site-editor/cli` — `avc`

Unified developer CLI for Avocado Studio. Wraps the orchestrator HTTP API so
common workflows (publish, check status, roll back) are available from the
terminal without the editor UI.

See `docs/ideas/avocado-cli.md` for the full product spec.

## Install

```bash
pnpm add -D @ai-site-editor/cli
# or run on-the-fly:
npx @ai-site-editor/cli <command>
```

## Commands (Phase 1)

| Command | Description |
|---|---|
| `avc publish` | Publish the current draft to the configured target |
| `avc status`  | Show publish status (Vercel state, deploy URL) |
| `avc diff`    | Show draft vs. published diff |

All commands accept:

| Flag | Env | Default |
|---|---|---|
| `--orchestrator <url>` | `ORCHESTRATOR_URL` | `http://localhost:4200` |
| `--session <name>` | `AVC_SESSION` | `dev` |
| `--site <id>` | `AVC_SITE_ID` / `NEXT_PUBLIC_DEFAULT_SITE_ID` | _required_ |
| `--site-origin <url>` | `SITE_ORIGIN` / `NEXT_PUBLIC_SITE_ORIGIN` | _unset_ |
| `--token <token>` | `PUBLISH_TOKEN` | _unset_ |

Values are resolved from CLI flags → `process.env` → `.env.local` in the
current directory.

## Examples

```bash
# Publish and wait for the deploy to go live
avc publish --site my-site --wait

# Inspect current status
avc status --site my-site

# Preview what publishing would change
avc diff --site my-site
```
