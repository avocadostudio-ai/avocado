import dotenv from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import {
  isLikelyClarificationFollowUp,
  parseCreatePageRequest
} from "./nlp/intent-helpers.js"
import { plannerMessageWithPendingContext } from "./nlp/intent-detection.js"
import { createChatTelemetryStore } from "./telemetry/chat-telemetry.js"
import { normalizePlanCandidate } from "./nlp/plan-normalizer.js"
import { buildCreatePagePlan, compileDeterministicPlan } from "./nlp/deterministic-planner.js"
import { type AIProvider, loadStateFromDisk } from "./state/session-state.js"
import { ensurePresetRestoreSessions } from "./publish/publish-helpers.js"
import type { RouteContext } from "./routes/route-context.js"
import { contentRoutes } from "./routes/content.js"
import { publishingRoutes } from "./routes/publishing.js"
import { chatRoutes } from "./routes/chat.js"
import { opsRoutes } from "./routes/ops.js"
import { mediaRoutes } from "./routes/media.js"
import { historyRoutes } from "./routes/history.js"
import { toolsRoutes } from "./routes/tools.js"
import { authRoutes } from "./routes/auth.js"
import { createToolRuntime } from "./tools/runtime.js"

const app = Fastify({ logger: true })

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenv.config({ path })
    break
  }
}

function normalizedOrigin(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function getAllowedCorsOrigins() {
  const configured = (process.env.ORCHESTRATOR_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => normalizedOrigin(origin))
    .filter(Boolean)
  if (configured.length > 0) return new Set(configured)
  return new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:4100",
    "http://127.0.0.1:4100"
  ])
}

const allowedCorsOrigins = getAllowedCorsOrigins()

await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (allowedCorsOrigins.has(normalizedOrigin(origin))) return cb(null, true)
    return cb(new Error("Origin not allowed"), false)
  }
})
await app.register(multipart, {
  limits: {
    files: 1,
    fileSize: 25 * 1024 * 1024
  }
})

const chatTelemetryFilePath = process.env.CHAT_TELEMETRY_FILE ?? resolve(process.cwd(), "../../.data/chat-telemetry.ndjson")
const generatedImageDir = process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? resolve(process.cwd(), "../../.data/generated-images")
const orchestratorPublicOrigin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")
const chatTelemetryLimit = Number(process.env.CHAT_TELEMETRY_LIMIT ?? 500)
const chatTelemetryPersistEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_TELEMETRY_PERSIST ?? "1").trim())
const chatTelemetry = createChatTelemetryStore({
  filePath: chatTelemetryFilePath,
  limit: chatTelemetryLimit,
  persistEnabled: chatTelemetryPersistEnabled,
  logger: app.log
})
const toolRuntime = await createToolRuntime({ logger: app.log })

const modelLookup = {
  openai: {
    fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
    balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o",
    reasoning: process.env.OPENAI_MODEL_REASONING ?? "o1",
    codex: process.env.OPENAI_MODEL_CODEX ?? "o3",
  },
  anthropic: {
    fast: process.env.ANTHROPIC_MODEL_FAST ?? "claude-haiku-4-5-20251001",
    balanced: process.env.ANTHROPIC_MODEL_BALANCED ?? "claude-sonnet-4-6",
    reasoning: process.env.ANTHROPIC_MODEL_REASONING ?? "claude-sonnet-4-6",
    codex: process.env.ANTHROPIC_MODEL_CODEX ?? "claude-opus-4-6",
  },
}
const availableProviders: AIProvider[] = [
  ...(process.env.OPENAI_API_KEY ? ["openai" as const] : []),
  ...(process.env.ANTHROPIC_API_KEY ? ["anthropic" as const] : []),
]

// ---------------------------------------------------------------------------
// Route plugins
// ---------------------------------------------------------------------------

const ctx: RouteContext = { chatTelemetry, modelLookup, availableProviders, generatedImageDir, orchestratorPublicOrigin, toolRuntime }

await app.register((instance) => contentRoutes(instance, ctx))
await app.register((instance) => publishingRoutes(instance, ctx))
await app.register((instance) => chatRoutes(instance, ctx))
await app.register((instance) => opsRoutes(instance, ctx))
await app.register((instance) => mediaRoutes(instance, ctx))
await app.register((instance) => historyRoutes(instance, ctx))
await app.register((instance) => toolsRoutes(instance, ctx))
await app.register((instance) => authRoutes(instance))

// ---------------------------------------------------------------------------
// Inline routes (health, status, telemetry, favicon)
// ---------------------------------------------------------------------------

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => ({
  plannerSource: availableProviders.length > 0 ? availableProviders[0] : "demo",
  availableProviders,
  unsplashConfigured: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim()),
  enabledTools: ctx.toolRuntime.registry.listManifests().map((tool) => tool.name)
}))
app.get("/telemetry/chat", async (request) => {
  const raw = request.query as { limit?: string; outcome?: string; phase?: string; session?: string }
  return chatTelemetry.list({
    limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
    outcome: raw.outcome,
    phase: raw.phase,
    session: raw.session
  })
})
app.get("/telemetry/chat/review", async (request) => {
  const raw = request.query as { limit?: string; session?: string }
  return chatTelemetry.review({
    limit: raw.limit !== undefined ? Number(raw.limit) : undefined,
    session: raw.session
  })
})
app.get("/favicon.ico", async (_request, reply) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0f172a"/>
  <path d="M32 10l4.6 12.4L49 27l-12.4 4.6L32 44l-4.6-12.4L15 27l12.4-4.6L32 10z" fill="#f8fafc"/>
  <path d="M49 36l2.2 6 6 2.2-6 2.2-2.2 6-2.2-6-6-2.2 6-2.2 2.2-6z" fill="#67e8f9"/>
  <path d="M18 36l1.6 4.2 4.2 1.6-4.2 1.6L18 48l-1.6-4.2-4.2-1.6 4.2-1.6L18 36z" fill="#a7f3d0"/>
</svg>`
  reply
    .header("content-type", "image/svg+xml; charset=utf-8")
    .header("cache-control", "public, max-age=86400")
    .send(svg)
})

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

async function startServer() {
  const port = Number(process.env.PORT ?? 4200)
  await loadStateFromDisk(app.log)
  await ensurePresetRestoreSessions(app.log)
  await chatTelemetry.loadFromDisk()
  await app.listen({ port, host: "0.0.0.0" })
  app.log.info(`Orchestrator listening on ${port}`)
}

if (process.env.NODE_ENV !== "test") {
  await startServer()
}

export {
  app,
  parseCreatePageRequest,
  buildCreatePagePlan,
  isLikelyClarificationFollowUp,
  plannerMessageWithPendingContext,
  normalizePlanCandidate,
  compileDeterministicPlan
}
