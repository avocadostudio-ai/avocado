# Netlify Deployment

This guide covers deploying AI Site Editor to Netlify.

## Architecture overview

| Component | Netlify product | Notes |
|-----------|----------------|-------|
| **Site** (`apps/site`) | Netlify Sites | Next.js on Netlify via `@netlify/plugin-nextjs` |
| **Editor** (`apps/editor`) | Netlify Sites | Static Vite build |
| **Orchestrator** (`apps/orchestrator`) | External host | Long-running Fastify server — deploy on Render, Fly, Railway, or any container host |

> **Note:** The orchestrator is a long-running stateful server and cannot run as a Netlify Function. Deploy it on a platform that supports persistent processes.

## Phase 1: Public site only (recommended start)

Deploy `apps/site` as a standalone Next.js site serving published content.

### Netlify project setup

1. Connect your repository to Netlify
2. Configure build settings:
   - **Base directory:** `apps/site`
   - **Build command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-site-editor/site build`
   - **Publish directory:** `apps/site/.next`
3. Install the Next.js plugin: add `@netlify/plugin-nextjs` to your `netlify.toml` or install via the Netlify UI

### netlify.toml (in repo root)

```toml
[build]
  base = "apps/site"
  command = "cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-site-editor/site build"
  publish = ".next"

[[plugins]]
  package = "@netlify/plugin-nextjs"
```

### Environment variables (Phase 1)

| Variable | Value | Required |
|----------|-------|----------|
| `NODE_VERSION` | `22` | Yes |
| `ORCHESTRATOR_URL` | _(leave unset)_ | No |

In Phase 1, the site renders from published content only — no orchestrator needed.

## Phase 2: Full editing stack

### Deploy the editor

Create a separate Netlify site for `apps/editor`:

- **Base directory:** `apps/editor`
- **Build command:** `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-site-editor/editor build`
- **Publish directory:** `apps/editor/dist`

### Editor environment variables

| Variable | Value |
|----------|-------|
| `VITE_SITE_ORIGIN` | `https://<your-site>.netlify.app` (no trailing slash) |
| `VITE_ORCHESTRATOR_URL` | `https://<your-orchestrator-host>` |
| `VITE_SITE_DRAFT_SECRET` | Shared secret (must match site's `DRAFT_MODE_SECRET`) |

### Deploy the orchestrator (external host)

The orchestrator requires a long-running process. Deploy on Render, Fly.io, Railway, or any container platform. See [vercel-deployment.md](vercel-deployment.md#orchestrator-on-render) for Render-specific instructions.

### Site environment variables (Phase 2)

| Variable | Value |
|----------|-------|
| `ORCHESTRATOR_URL` | `https://<your-orchestrator-host>` |
| `NEXT_PUBLIC_ENABLE_EDITOR` | `1` |
| `NEXT_PUBLIC_EDITOR_ORIGIN` | `https://<your-editor>.netlify.app` (no trailing slash) |
| `DRAFT_MODE_SECRET` | Shared secret (must match editor's `VITE_SITE_DRAFT_SECRET`) |

## Other platforms

Deployment guides for the following platforms are planned:

- **AWS Amplify** — Next.js hosting + Lambda for orchestrator
- **Google Cloud Run** — Container-based deployment for all three services
- **Docker Compose** — Self-hosted deployment on any server

Contributions welcome! See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Troubleshooting

See the [production troubleshooting](vercel-deployment.md#production-troubleshooting) section — the same postMessage, CORS, and draft mode issues apply regardless of hosting platform.
