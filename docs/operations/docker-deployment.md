# Docker Deployment (Orchestrator)

The whole stack is Apache 2.0-licensed and source-available in the [public repo](https://github.com/avocadostudio-ai/avocado). For self-hosting the orchestrator, Docker is the recommended path — a single reproducible artifact with its Node.js runtime and dependencies baked in. The site and Content Studio apps don't need Docker and can run on any Node.js host.

## Why Docker for the orchestrator?

- **Single artifact** — One image contains the orchestrator, its Node.js runtime, and all dependencies
- **Reproducible** — No Node version or pnpm mismatch issues on production hosts
- **Easy rollbacks** — Tag and pin image versions
- **State isolation** — Persistent state lives in a mounted volume

The site (`apps/site`) and Content Studio (`apps/editor`) don't need Docker — they can deploy as static/serverless apps to Vercel, Netlify, Cloudflare Pages, or any Node.js host.

## Building the image

From the repository root:

```bash
docker build -f apps/orchestrator/Dockerfile -t avocado-orchestrator:latest .
```

The build is multi-stage and uses the pnpm workspace to install only the orchestrator's dependencies (`packages/shared`, `packages/migration-sdk`).

## Running standalone

```bash
docker run -d \
  --name avocado-orchestrator \
  -p 4200:4200 \
  --env-file .env \
  -v avocado-data:/app/.data \
  avocado-orchestrator:latest
```

### Required environment variables

At minimum you need **one** AI provider key:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (recommended — most battle-tested) |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_GENAI_API_KEY` | Google Gemini API key |

### CORS configuration

By default the container accepts requests from `http://localhost:3000` and `http://localhost:4100`. For production, set the allowed origins explicitly:

```bash
ORCHESTRATOR_CORS_ORIGINS=https://your-site.example.com,https://studio.example.com
```

### State persistence

The orchestrator writes session state, telemetry, and generated images to `/app/.data` inside the container. Mount a volume there to persist data across restarts:

```bash
-v avocado-data:/app/.data
```

The image sets these env vars by default:
- `ORCHESTRATOR_STATE_FILE=/app/.data/orchestrator-state.json`
- `CHAT_TELEMETRY_FILE=/app/.data/chat-telemetry.ndjson`
- `ORCHESTRATOR_GENERATED_IMAGE_DIR=/app/.data/generated-images`

## Using docker-compose

A `docker-compose.yml` at the repo root runs the orchestrator with sensible defaults:

```bash
docker compose up -d
docker compose logs -f orchestrator
docker compose down
```

The compose file uses a named volume (`orchestrator-data`) and loads env vars from `.env` at the repo root.

## Health check

The container includes a health check that polls `http://127.0.0.1:4200/health` every 30 seconds. Check status with:

```bash
docker inspect --format='{{.State.Health.Status}}' avocado-orchestrator
```

## Environment reference

See `.env.example` at the repo root for the complete list of environment variables. The orchestrator-specific ones are under the `# --- Orchestrator tuning ---` section.

Common overrides for Docker deployments:

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default: 4200) |
| `NODE_ENV` | `production` by default in the image |
| `ORCHESTRATOR_CORS_ORIGINS` | Comma-separated list of allowed origins |
| `ORCHESTRATOR_STATE_FILE` | Path to session state JSON |
| `CHAT_TELEMETRY_FILE` | Path to telemetry NDJSON |
| `ORCHESTRATOR_GENERATED_IMAGE_DIR` | Directory for generated images |
| `PUBLISH_TOKEN` | Required token for `/publish/*` endpoints |
| `ACCESS_PASSWORD_HASH` | Optional password hash for `/auth/verify` |

## Running locally without Docker

Docker is optional. You can still run the orchestrator directly via pnpm for local development:

```bash
pnpm install
pnpm dev:start        # starts site + editor + orchestrator via tsx
# or run just the orchestrator:
pnpm --filter @ai-site-editor/orchestrator dev
```

The Dockerfile is an **additional** distribution option, not a replacement for the local dev workflow.

## Troubleshooting

### Container exits immediately
Check logs: `docker logs avocado-orchestrator`. The most common cause is missing API keys or an invalid `.env` file.

### CORS errors from editor/site
Set `ORCHESTRATOR_CORS_ORIGINS` to include both the site and Content Studio origins (no trailing slashes).

### State not persisting
Ensure the volume is mounted at `/app/.data` and that the container user has write permissions.

### Health check failing
Wait for the 10-second start period. If it still fails, check that the orchestrator is listening on `0.0.0.0:4200` (it should be by default) and that no firewall is blocking the port.
