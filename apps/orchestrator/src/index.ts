import dotenv from "dotenv"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import swagger from "@fastify/swagger"
import {
  isLikelyClarificationFollowUp,
  parseCreatePageRequest
} from "./nlp/intent-helpers.js"
import { plannerMessageWithPendingContext } from "./nlp/intent-detection.js"
import { createChatTelemetryStore } from "./telemetry/chat-telemetry.js"
import { createEvalCandidateStore } from "./telemetry/eval-candidate-store.js"
import { normalizePlanCandidate } from "./nlp/plan-normalizer.js"
import { buildCreatePagePlan, compileDeterministicPlan } from "./nlp/deterministic-planner.js"
import { type AIProvider, loadStateFromDisk, persistStateNow } from "./state/session-state.js"
import {
  resetStore,
  resolveBackupIntervalHours,
  resolveBackupLimit,
  resolveDbFile,
  runSqliteBackup,
} from "./state/sqlite-store-singleton.js"
import { ensurePresetRestoreSessions } from "./publish/publish-helpers.js"
import type { RouteContext } from "./routes/route-context.js"
import { contentRoutes } from "./routes/content.js"
import { publishingRoutes } from "./routes/publishing.js"
import { chatRoutes } from "./routes/chat.js"
import { opsRoutes } from "./routes/ops.js"
import { mediaRoutes } from "./routes/media.js"
import { historyRoutes } from "./routes/history.js"
import { authRoutes } from "./routes/auth.js"
import { gdriveRoutes } from "./routes/gdrive.js"
import { registerAgentRoutes } from "./routes/agent.js"
import { registerSitesAgentRoutes } from "./routes/sites-agent.js"
import { sitesRoutes } from "./routes/sites.js"
import { jiraRoutes } from "./routes/jira.js"
import { createToolRuntime } from "./tools/runtime.js"
import {
  isDemoModeEnabled,
  getDemoAllowedOpTypes,
  getDemoAllowedBlockTypes,
  getDemoRateLimitPerHour,
  demoSessionKeyForIp,
  extractClientIp,
  consumeDemoRateToken
} from "./demo-mode.js"

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

// ---------------------------------------------------------------------------
// OpenAPI / Swagger
// ---------------------------------------------------------------------------
//
// Generates an OpenAPI 3.0 spec from the registered route handlers. Most
// orchestrator routes don't have Fastify schemas attached today, so the
// generated spec is largely a skeleton — see
// docs-site/api-reference/index.mdx for the public-facing acknowledgement,
// and the `orchestrator_openapi_improvements` memory for the deferred plan
// to upgrade this with real Zod schemas via fastify-type-provider-zod.
//
// Internal routes are filtered out so the public spec only documents the
// surface external clients should rely on.
const INTERNAL_ROUTE_PREFIXES = [
  "/telemetry/",
  "/contentful/",
  "/gdrive/",
  "/jira/",
  "/audio/",
  "/restore/",
  "/agent/",        // legacy agent endpoints — superseded by /sites-agent/*
  "/published/",    // legacy publish-eager endpoint
  "/status/",       // internal debug
  "/favicon.ico",
  "/generated-images/",
]

await app.register(swagger, {
  openapi: {
    openapi: "3.0.3",
    info: {
      title: "Avocado Studio Orchestrator API",
      description: "HTTP API exposed by the orchestrator. The brain that runs editor sessions, calls the LLMs, and serves draft state to integrated sites.\n\n**Note**: this spec is auto-generated from the running Fastify routes. Most routes do not have request/response schemas attached today, so signatures are skeletal — request bodies and response payloads are documented in the route source for now. See [the API Reference index](/api-reference) for context.",
      version: "0.0.1",
    },
    servers: [
      {
        url: "http://localhost:4200",
        description: "Local development orchestrator (default port)",
      },
    ],
    tags: [
      { name: "Sites", description: "Site registration and listing" },
      { name: "Chat", description: "AI chat / planning endpoints" },
      { name: "Sites Agent", description: "Site onboarding agent (migrate / integrate / create)" },
      { name: "Draft", description: "Draft content read endpoints called by integrated sites" },
      { name: "Publish", description: "Publishing and content snapshot endpoints" },
      { name: "History", description: "Undo / redo / version log" },
      { name: "Auth", description: "Optional access password gate" },
      { name: "Media", description: "Image upload and generation" },
      { name: "Health", description: "Service health and readiness" },
    ],
  },
  hideUntagged: false,
  // Filter out internal routes — they shouldn't appear in the public spec.
  transform: ({ schema, url }) => {
    const isInternal = INTERNAL_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix))
    if (isInternal) {
      return { schema: { ...schema, hide: true }, url }
    }
    return { schema, url }
  },
})

// Expose the spec at /docs/json so the export script (and any external tooling)
// can fetch it. Memoized: route table is fixed after `app.ready()`, so
// `app.swagger()` is deterministic and there's no need to recompute per call.
let cachedSwaggerSpec: object | null = null
app.get("/docs/json", async () => (cachedSwaggerSpec ??= app.swagger()))

const chatTelemetryFilePath = process.env.CHAT_TELEMETRY_FILE ?? resolve(process.cwd(), "../../.data/chat-telemetry.ndjson")
const generatedImageDir = process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? resolve(process.cwd(), "../../.data/generated-images")
const orchestratorPublicOrigin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")
const sitePublicOrigin = (process.env.SITE_PUBLIC_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "")
const chatTelemetryLimit = Number(process.env.CHAT_TELEMETRY_LIMIT ?? 500)
const chatTelemetryPersistEnabled = !/^(0|false|no|off)$/i.test((process.env.CHAT_TELEMETRY_PERSIST ?? "1").trim())

const evalCandidatesEnabled = !/^(0|false|no|off)$/i.test((process.env.EVAL_CANDIDATES_ENABLED ?? "1").trim())
const evalCandidatesFilePath = process.env.EVAL_CANDIDATES_FILE ?? resolve(process.cwd(), "../../.data/eval-candidates.ndjson")
const evalCandidatesLimit = Number(process.env.EVAL_CANDIDATES_LIMIT ?? 1000)
const evalCandidatesTtlDays = Number(process.env.EVAL_CANDIDATES_TTL_DAYS ?? 7)
const evalCandidates = evalCandidatesEnabled
  ? createEvalCandidateStore({
      filePath: evalCandidatesFilePath,
      limit: evalCandidatesLimit,
      persistEnabled: true,
      ttlDays: evalCandidatesTtlDays,
      logger: app.log
    })
  : undefined

const chatTelemetry = createChatTelemetryStore({
  filePath: chatTelemetryFilePath,
  limit: chatTelemetryLimit,
  persistEnabled: chatTelemetryPersistEnabled,
  logger: app.log,
  onPush: evalCandidates
    ? (entry) => {
        if (entry.phase !== "result") return
        evalCandidates.finalize(entry.id, {
          outcome: entry.outcome,
          reasonCategory: entry.reasonCategory,
          plannerTier: entry.plannerTier,
          opTypes: entry.opTypes,
          opCount: entry.opCount
        })
      }
    : undefined
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
  gemini: {
    fast: process.env.GOOGLE_GENAI_MODEL_FAST ?? "gemini-2.5-flash",
    balanced: process.env.GOOGLE_GENAI_MODEL_BALANCED ?? "gemini-2.5-flash",
    reasoning: process.env.GOOGLE_GENAI_MODEL_REASONING ?? "gemini-2.5-pro",
    codex: process.env.GOOGLE_GENAI_MODEL_CODEX ?? "gemini-2.5-pro",
  },
}
const availableProviders: AIProvider[] = [
  ...(process.env.OPENAI_API_KEY ? ["openai" as const] : []),
  ...(process.env.ANTHROPIC_API_KEY ? ["anthropic" as const] : []),
  ...(process.env.GOOGLE_GENAI_API_KEY ? ["gemini" as const] : []),
]

// ---------------------------------------------------------------------------
// Route plugins
// ---------------------------------------------------------------------------

const ctx: RouteContext = { chatTelemetry, evalCandidates, modelLookup, availableProviders, generatedImageDir, orchestratorPublicOrigin, sitePublicOrigin, toolRuntime }

await app.register((instance) => contentRoutes(instance, ctx))
await app.register((instance) => publishingRoutes(instance, ctx))
await app.register((instance) => chatRoutes(instance, ctx))
await app.register((instance) => opsRoutes(instance, ctx))
await app.register((instance) => mediaRoutes(instance, ctx))
await app.register((instance) => historyRoutes(instance, ctx))
await app.register((instance) => authRoutes(instance))
await app.register((instance) => gdriveRoutes(instance, ctx))
await app.register((instance) => registerAgentRoutes(instance))
await app.register((instance) => registerSitesAgentRoutes(instance, ctx))
await app.register((instance) => sitesRoutes(instance, ctx))
await app.register((instance) => jiraRoutes(instance, ctx))

// ---------------------------------------------------------------------------
// Demo mode gate — runs once at startup, no-op when DEMO_MODE is off.
// See apps/orchestrator/src/demo-mode.ts for the rationale.
// ---------------------------------------------------------------------------
if (isDemoModeEnabled()) {
  app.log.info({
    allowedOps: getDemoAllowedOpTypes(),
    allowedBlockTypes: getDemoAllowedBlockTypes(),
    rateLimitPerHour: getDemoRateLimitPerHour()
  }, "[demo-mode] enabled — all sessions will be gated")

  // Paths that require rate limiting + per-IP session rewriting. /health,
  // /status/*, /draft/* and /favicon stay open so the site preview and the
  // editor's status poller keep working.
  const GATED_PREFIXES = ["/chat", "/ops"]
  // Agent routes are hard-blocked in demo mode — they bypass the op gate and
  // would let a visitor run arbitrary multi-turn agent loops on your key.
  const BLOCKED_PREFIXES = ["/agent", "/sites-agent", "/jira"]

  app.addHook("preHandler", async (request, reply) => {
    const url = request.url.split("?")[0] ?? ""

    if (BLOCKED_PREFIXES.some((p) => url.startsWith(p))) {
      reply.code(403).send({ error: "This endpoint is disabled in demo mode." })
      return reply
    }

    if (!GATED_PREFIXES.some((p) => url.startsWith(p))) return

    const ip = extractClientIp(request)
    const rate = consumeDemoRateToken(ip)
    if (!rate.ok) {
      reply
        .header("retry-after", String(rate.retryAfterSeconds))
        .code(429)
        .send({
          error: "Demo rate limit reached — try again later.",
          retryAfterSeconds: rate.retryAfterSeconds
        })
      return reply
    }

    // Rewrite session + siteId on the request body so downstream handlers
    // transparently operate on this visitor's ephemeral session. We target
    // the default legacy site id so `scopedSessionKey` returns the bare
    // session name, which routes through the auto-seeded default path in
    // `getSessionDraft`.
    const body = request.body as
      | { session?: string; siteId?: string }
      | undefined
    if (body && typeof body === "object") {
      body.session = demoSessionKeyForIp(ip)
      body.siteId = "avocado-stories"
    }
  })
}

// ---------------------------------------------------------------------------
// Inline routes (health, status, telemetry, favicon)
// ---------------------------------------------------------------------------

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => {
  const demoMode = isDemoModeEnabled()
  return {
    // In demo mode we always report "demo" as the planner source so the
    // editor shows the demo badge, even though real providers are wired up
    // under the hood via your shared key.
    plannerSource: demoMode ? "demo" : (availableProviders.length > 0 ? availableProviders[0] : "demo"),
    availableProviders,
    demoMode,
    demo: demoMode
      ? {
          allowedOps: getDemoAllowedOpTypes(),
          allowedBlockTypes: getDemoAllowedBlockTypes(),
          rateLimitPerHour: getDemoRateLimitPerHour()
        }
      : undefined,
    enabledTools: ctx.toolRuntime.registry.listManifests().map((tool) => tool.name),
    features: {
      googleDrive: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON?.trim() || process.env.GOOGLE_API_KEY?.trim()),
      unsplash: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim()),
      // In demo mode image gen is off even if a key is present, so the UI
      // shouldn't advertise it.
      imageGenerate: demoMode ? false : Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.GOOGLE_GENAI_API_KEY?.trim()),
      imageGenerateChat: demoMode ? false : Boolean(process.env.GOOGLE_GENAI_API_KEY?.trim()),
      contentful: Boolean(process.env.CONTENTFUL_SPACE_ID?.trim() && process.env.CONTENTFUL_DELIVERY_TOKEN?.trim()),
      agentMode: demoMode ? false : Boolean(process.env.AGENT_API_KEY?.trim()),
    }
  }
})
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

let backupTimer: NodeJS.Timeout | null = null

function startSqliteBackupLoop() {
  const dbFile = resolveDbFile()
  if (dbFile === ":memory:") return
  const limit = resolveBackupLimit()
  const hours = resolveBackupIntervalHours()
  const intervalMs = hours * 60 * 60 * 1000
  const tick = () => {
    void runSqliteBackup(dbFile, limit, app.log)
  }
  // Run once shortly after startup so a crashed process didn't skip
  // today's backup, then on the configured interval.
  const initial = setTimeout(tick, 60_000)
  initial.unref?.()
  backupTimer = setInterval(tick, intervalMs)
  backupTimer.unref?.()
}

async function startServer() {
  const port = Number(process.env.PORT ?? 4200)
  await loadStateFromDisk(app.log)
  await ensurePresetRestoreSessions(app.log)
  await chatTelemetry.loadFromDisk()
  if (evalCandidates) await evalCandidates.loadFromDisk()
  await app.listen({ port, host: "0.0.0.0" })
  app.log.info(`Orchestrator listening on ${port}`)
  startSqliteBackupLoop()

  // Start JIRA poller if configured
  if (process.env.JIRA_POLL_ENABLED === "1") {
    const { loadJiraConfig } = await import("./jira/jira-types.js")
    const { startJiraPoller } = await import("./jira/jira-poller.js")
    const jiraConfig = loadJiraConfig()
    if (jiraConfig) {
      startJiraPoller({ config: jiraConfig, generatedImageDir, orchestratorPublicOrigin, sitePublicOrigin, logger: app.log })
    } else {
      app.log.warn("JIRA_POLL_ENABLED=1 but JIRA_BASE_URL or JIRA_API_TOKEN not set — poller not started")
    }
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown — drain Fastify first so no new mutations can land, then
// flush pending state, then close the SQLite handle so the WAL is
// checkpointed cleanly. Render/docker otherwise leaves `.db-wal` behind.
// ---------------------------------------------------------------------------
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, "Orchestrator shutting down")
  if (backupTimer) clearInterval(backupTimer)
  // 1. Stop accepting new requests + wait for in-flight handlers to finish.
  //    Those finishing handlers call schedulePersistState against the still-
  //    open store, so their mutations are already durable by the time
  //    app.close() resolves.
  try {
    await app.close()
  } catch (err) {
    app.log.error({ err }, "Fastify close failed")
  }
  // 2. Flush the final debounced write (if any) synchronously.
  try {
    await persistStateNow(app.log)
  } catch (err) {
    app.log.error({ err }, "Final state flush failed")
  }
  // 3. Close the DB handle — triggers a WAL checkpoint on exit.
  try {
    resetStore()
  } catch (err) {
    app.log.error({ err }, "SqliteStore close failed")
  }
  process.exit(0)
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { void shutdown(sig) })
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
