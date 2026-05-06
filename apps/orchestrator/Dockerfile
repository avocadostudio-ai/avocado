# syntax=docker/dockerfile:1.7
# Multi-stage build for the AI Site Editor orchestrator.
#
# Build from repo root:
#   docker build -f apps/orchestrator/Dockerfile -t avocado-orchestrator .
#
# Run:
#   docker run -p 4200:4200 --env-file .env -v avocado-data:/app/.data avocado-orchestrator

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate
WORKDIR /app

# ---- Dependencies ---------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/orchestrator/package.json apps/orchestrator/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/migration-sdk/package.json packages/migration-sdk/package.json

RUN pnpm install --frozen-lockfile --filter @ai-site-editor/orchestrator...

# ---- Runtime --------------------------------------------------------------
FROM base AS runtime

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/orchestrator/node_modules ./apps/orchestrator/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/migration-sdk/node_modules ./packages/migration-sdk/node_modules

# Copy workspace manifests and source
COPY package.json pnpm-workspace.yaml ./
COPY apps/orchestrator/ apps/orchestrator/
COPY packages/shared/ packages/shared/
COPY packages/migration-sdk/ packages/migration-sdk/

# Persistent state lives under /app/.data (mount a volume here)
RUN mkdir -p /app/.data

ENV NODE_ENV=production
ENV PORT=4200
ENV ORCHESTRATOR_STATE_FILE=/app/.data/orchestrator-state.json
ENV CHAT_TELEMETRY_FILE=/app/.data/chat-telemetry.ndjson
ENV ORCHESTRATOR_GENERATED_IMAGE_DIR=/app/.data/generated-images

EXPOSE 4200

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4200/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

WORKDIR /app/apps/orchestrator
CMD ["npx", "tsx", "src/index.ts"]
