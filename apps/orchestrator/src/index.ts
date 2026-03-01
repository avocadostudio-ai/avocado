import dotenv from "dotenv"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import OpenAI from "openai"
import { toFile } from "openai/uploads"
import { z } from "zod"
import {
  operationSchema,
  type PageDoc
} from "@ai-site-editor/shared"
import {
  isLikelyClarificationFollowUp,
  parseCreatePageRequest
} from "./nlp/intent-helpers.js"
import {
  type ChatRequestBody,
  plannerMessageWithPendingContext
} from "./nlp/intent-detection.js"
import { createChatTelemetryStore } from "./telemetry/chat-telemetry.js"
import {
  type ModelKey,
  type PublishTracker,
  normalizeSession,
  scopedSessionKey,
  publishedPages,
  historyUndo,
  historyRedo,
  publishStatusBySession,
  ensureHeroImageProps,
  orderSlugsHomeFirst,
  getSessionDraft,
  getHistoryMap,
  getPage,
  getSessionPages,
  setPage,
  pushUndo,
  bumpVersion,
  pushRecentEdit,
  schedulePersistState,
  loadStateFromDisk
} from "./state/session-state.js"
import { normalizePlanCandidate } from "./nlp/plan-normalizer.js"
import {
  toErrorDetail,
  classifyGuardrailError,
  applyOpsAtomically,
  pickFocusBlockId,
  pickUpdatedSlug
} from "./ops/ops-engine.js"
import {
  buildCreatePagePlan,
  compileDeterministicPlan
} from "./nlp/deterministic-planner.js"
import { openAIChatOptionsForModel } from "./chat/planner.js"
import {
  deploymentIdFromAny,
  refreshPublishStatusFromVercel,
  requirePublishToken,
  listRestoreSnapshots,
  loadPublishedSnapshotFromCommit,
  ensurePresetRestoreSessions,
  publishViaGit
} from "./publish/publish-helpers.js"
import {
  type ChatPipelineContext,
  firstUrlFromText,
  collectMentionedSlugsFromOps,
  sseWrite,
  runChatPipeline
} from "./chat/chat-pipeline.js"
import {
  type VariationRequestBody,
  parseJsonMaybe,
  runVariationPipeline
} from "./chat/variation-pipeline.js"

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

function findStringByKeys(root: unknown, wanted: Set<string>): string | undefined {
  if (!root || typeof root !== "object") return undefined
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findStringByKeys(item, wanted)
      if (found) return found
    }
    return undefined
  }
  const obj = root as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && wanted.has(key)) return value
    if (value && typeof value === "object") {
      const found = findStringByKeys(value, wanted)
      if (found) return found
    }
  }
  return undefined
}

const modelLookup = {
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o",
  reasoning: process.env.OPENAI_MODEL_REASONING ?? "o1",
  codex: process.env.OPENAI_MODEL_CODEX ?? "o3"
} as const

type ApplyOpsRequestBody = {
  session?: string
  siteId?: string
  ops?: unknown
}

const allowedTranscriptionMimeTypes = new Set([
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/mpga",
  "audio/m4a",
  "audio/wav",
  "audio/webm"
])
const allowedImageAnalysisMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
])

function parseTranscriptionModelList(raw: string | undefined) {
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

const pipelineCtx: ChatPipelineContext = { log: app.log, chatTelemetry, modelLookup }

app.get("/published/pages", async (request, reply) => {
  const query = request.query as { slug?: string }
  if (!query.slug) return reply.code(400).send({ error: "slug is required" })

  const page = publishedPages.get(query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })
  return structuredClone(page)
})

app.get("/draft/pages", async (request, reply) => {
  const query = request.query as { session?: string; siteId?: string; slug?: string }
  if (!query.slug || !query.session) return reply.code(400).send({ error: "session and slug are required" })
  const session = scopedSessionKey(query.session, query.siteId)

  const page = getPage(session, query.slug)
  if (!page) return reply.code(404).send({ error: "not found" })

  return structuredClone(page)
})

app.get("/draft/slugs", async (request, reply) => {
  const query = request.query as { session?: string; siteId?: string }
  const session = scopedSessionKey(query.session, query.siteId)
  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return { slugs }
})

app.get("/generated-images/:fileName", async (request, reply) => {
  const params = request.params as { fileName?: string }
  const fileName = typeof params.fileName === "string" ? params.fileName.trim() : ""
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(fileName)) {
    return reply.code(400).send({ error: "invalid filename" })
  }

  try {
    const bytes = await readFile(resolve(generatedImageDir, fileName))
    reply.header("content-type", "image/png")
    reply.header("cache-control", "public, max-age=31536000, immutable")
    return reply.send(bytes)
  } catch {
    return reply.code(404).send({ error: "not found" })
  }
})

app.get("/publish/content", async (request, reply) => {
  const query = request.query as { session?: string; siteId?: string }
  const session = normalizeSession(query.session)
  const scopedSession = scopedSessionKey(session, query.siteId)
  const pages = getSessionPages(scopedSession)
  return {
    session,
    slugs: pages.map((page) => page.slug),
    pages,
    generatedAt: new Date().toISOString()
  }
})

app.post("/publish", async (request, reply) => {
  if (!requirePublishToken(request as { headers: Record<string, unknown> })) {
    return reply.code(401).send({ error: "invalid publish token" })
  }

  const body = (request.body ?? {}) as { session?: string; siteId?: string }
  const session = normalizeSession(body.session)
  const scopedSession = scopedSessionKey(session, body.siteId)
  const publishMode = (process.env.PUBLISH_MODE?.trim().toLowerCase() || "deploy_hook") as "deploy_hook" | "git"

  if (publishMode === "git") {
    const result = await publishViaGit(scopedSession)
    const tracker: PublishTracker = {
      session,
      status: result.status === "failed" ? "failed" : "triggered",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slugs: result.slugs,
      vercelState: result.status === "failed" ? "ERROR" : "READY",
      deployResponse: "git_publish",
      deployStatus: result.status === "failed" ? 500 : 200
    }
    publishStatusBySession.set(scopedSession, tracker)

    if (result.status === "failed") {
      return reply.code(400).send({
        status: "failed",
        session,
        slugs: result.slugs,
        reason: result.reason,
        details: result.details
      })
    }

    return {
      status: result.status,
      session,
      slugs: result.slugs,
      branch: result.branch,
      commitSha: result.commitSha,
      message: result.message,
      vercelState: result.vercelState ?? "READY"
    }
  }

  const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL?.trim()
  if (!deployHookUrl) {
    return reply.code(400).send({ error: "VERCEL_DEPLOY_HOOK_URL is not configured" })
  }

  const pages = getSessionPages(scopedSession)
  const slugs = pages.map((page) => page.slug)

  try {
    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "orchestrator",
        session: scopedSession,
        slugs,
        publishedAt: new Date().toISOString()
      })
    })

    const responseText = await hookResponse.text()
    const responseJson = parseJsonMaybe(responseText)
    const inspectUrl =
      findStringByKeys(responseJson, new Set(["inspectorUrl", "inspectUrl", "url"])) ?? firstUrlFromText(responseText)
    const deploymentId =
      findStringByKeys(responseJson, new Set(["deploymentId", "id"])) ??
      (inspectUrl ? deploymentIdFromAny(inspectUrl) : undefined) ??
      deploymentIdFromAny(responseText)
    const vercelStateRaw =
      findStringByKeys(responseJson, new Set(["state", "readyState", "status"])) ??
      (hookResponse.ok ? "TRIGGERED" : "FAILED")
    const vercelState = typeof vercelStateRaw === "string" ? vercelStateRaw.toUpperCase() : undefined

    const tracker: PublishTracker = {
      session,
      status: hookResponse.ok ? "triggered" : "failed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slugs,
      deployStatus: hookResponse.status,
      deployResponse: responseText.slice(0, 500),
      inspectUrl,
      deploymentId,
      vercelState
    }
    publishStatusBySession.set(scopedSession, tracker)

    return {
      status: hookResponse.ok ? "triggered" : "failed",
      session,
      slugs,
      deployStatus: hookResponse.status,
      deployResponse: responseText.slice(0, 500),
      inspectUrl,
      deploymentId,
      vercelState
    }
  } catch (error) {
    return reply.code(502).send({ error: toErrorDetail(error) })
  }
})

app.get("/publish/status", async (request, reply) => {
  const query = request.query as { session?: string; siteId?: string }
  const session = normalizeSession(query.session)
  const scopedSession = scopedSessionKey(session, query.siteId)
  const current = publishStatusBySession.get(scopedSession)
  if (!current) return reply.code(404).send({ error: "no publish status for session" })
  const refreshed = await refreshPublishStatusFromVercel(current)
  publishStatusBySession.set(scopedSession, refreshed)
  return refreshed
})

app.get("/restore/snapshots", async (request, reply) => {
  const query = request.query as { limit?: string }
  const limit = query.limit ? Number(query.limit) : 30
  try {
    const snapshots = await listRestoreSnapshots(Number.isFinite(limit) ? limit : 30)
    return { snapshots }
  } catch (error) {
    return reply.code(500).send({ error: toErrorDetail(error) })
  }
})

app.post("/restore/snapshot", async (request, reply) => {
  const body = (request.body ?? {}) as { commit?: string; session?: string; siteId?: string }
  const commit = typeof body.commit === "string" ? body.commit.trim() : ""
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return reply.code(400).send({ error: "commit is required (7-40 hex chars)" })
  }

  const session = normalizeSession(body.session)
  const scopedSession = scopedSessionKey(session, body.siteId)

  try {
    const pages = await loadPublishedSnapshotFromCommit(commit)
    const draft = getSessionDraft(scopedSession)
    draft.clear()
    for (const page of pages) {
      const clone = structuredClone(page)
      ensureHeroImageProps(clone)
      draft.set(clone.slug, clone)
    }
    const previewVersion = bumpVersion(scopedSession)
    schedulePersistState(app.log)
    return {
      status: "restored",
      commit: commit.slice(0, 7),
      session,
      scopedSession,
      slugs: pages.map((page) => page.slug),
      previewVersion
    }
  } catch (error) {
    return reply.code(400).send({ error: toErrorDetail(error) })
  }
})

app.post("/ops", async (request, reply) => {
  const body = request.body as ApplyOpsRequestBody
  const session = scopedSessionKey(body.session, body.siteId)
  const parsedOps = z.array(operationSchema).safeParse(body.ops)
  if (!parsedOps.success) return reply.code(400).send({ error: "invalid ops payload" })
  if (parsedOps.data.length === 0) return reply.code(400).send({ error: "ops must not be empty" })

  const snapshots = new Map<string, PageDoc>()
  for (const op of parsedOps.data) {
    if (!("pageSlug" in op) || typeof op.pageSlug !== "string") continue
    if (snapshots.has(op.pageSlug)) continue
    const current = getPage(session, op.pageSlug)
    if (!current) return reply.code(404).send({ error: `page not found: ${op.pageSlug}` })
    snapshots.set(op.pageSlug, current)
  }

  try {
    applyOpsAtomically(session, parsedOps.data)
    for (const [slug, snapshot] of snapshots) pushUndo(session, slug, snapshot)
    const firstSlugOp = parsedOps.data.find((op) => "pageSlug" in op && typeof op.pageSlug === "string")
    const firstSlug = firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string" ? firstSlugOp.pageSlug : undefined
    const updatedSlug = firstSlug ? pickUpdatedSlug(session, firstSlug, parsedOps.data) : undefined
    if (firstSlugOp && "pageSlug" in firstSlugOp && typeof firstSlugOp.pageSlug === "string") {
      pushRecentEdit(session, { slug: updatedSlug ?? firstSlugOp.pageSlug, summary: "Applied operations.", ops: parsedOps.data })
    }
    const previewVersion = bumpVersion(session)
    schedulePersistState(app.log)
    const focusBlockId = pickFocusBlockId(parsedOps.data)
    return {
      status: "applied",
      summary: "Applied operations.",
      changes: [],
      mentionedSlugs: collectMentionedSlugsFromOps(parsedOps.data, updatedSlug ?? firstSlug),
      previewVersion,
      focusBlockId,
      updatedSlug
    }
  } catch (error) {
    const reason = toErrorDetail(error)
    return reply.code(400).send({ error: reason, errorCode: classifyGuardrailError(reason) })
  }
})

app.post("/chat", async (request, reply) => {
  const body = request.body as ChatRequestBody
  const result = await runChatPipeline(pipelineCtx, { ...body, session: scopedSessionKey(body.session, body.siteId) })
  return reply.code(result.code).send(result.payload)
})

app.post("/chat/variations", async (request, reply) => {
  const body = request.body as VariationRequestBody
  const result = await runVariationPipeline(pipelineCtx, { ...body, session: scopedSessionKey(body.session, body.siteId) })
  return reply.code(result.code).send(result.payload)
})

app.post("/audio/transcribe", async (request, reply) => {
  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({ error: "OPENAI_API_KEY is not configured" })
  }

  const inputFile = await request.file()
  if (!inputFile) return reply.code(400).send({ error: "audio file is required" })
  if (inputFile.fieldname !== "audio") return reply.code(400).send({ error: "audio field must be named 'audio'" })
  if (!allowedTranscriptionMimeTypes.has(inputFile.mimetype)) {
    return reply.code(415).send({
      error: `unsupported audio type: ${inputFile.mimetype}`
    })
  }

  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of inputFile.file) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += data.byteLength
    if (totalBytes > 25 * 1024 * 1024) {
      return reply.code(413).send({ error: "audio file is too large (max 25MB)" })
    }
    chunks.push(data)
  }

  if (totalBytes === 0) return reply.code(400).send({ error: "audio file is empty" })

  const primaryModel = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe"
  const fallbackModels = parseTranscriptionModelList(process.env.OPENAI_TRANSCRIBE_FALLBACK_MODELS)
  const modelsToTry = Array.from(new Set([primaryModel, ...fallbackModels]))
  const filename = inputFile.filename || `recording.${inputFile.mimetype.split("/")[1] ?? "webm"}`
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const audioFile = await toFile(Buffer.concat(chunks), filename, { type: inputFile.mimetype })
    const errors: string[] = []

    for (const model of modelsToTry) {
      try {
        const transcription = await client.audio.transcriptions.create({
          file: audioFile,
          model
        })

        return {
          text: transcription.text ?? "",
          model,
          bytes: totalBytes,
          mimeType: inputFile.mimetype,
          fallbackUsed: model !== primaryModel
        }
      } catch (error) {
        errors.push(`${model}: ${toErrorDetail(error)}`)
      }
    }

    return reply.code(502).send({
      error: "transcription failed",
      detail: errors.join(" | ").slice(0, 1200)
    })
  } catch (error) {
    return reply.code(502).send({ error: "transcription failed", detail: toErrorDetail(error) })
  }
})

app.post("/image/interpret", async (request, reply) => {
  if (!process.env.OPENAI_API_KEY) {
    return reply.code(503).send({ error: "OPENAI_API_KEY is not configured" })
  }

  const inputFile = await request.file()
  if (!inputFile) return reply.code(400).send({ error: "image file is required" })
  if (inputFile.fieldname !== "image") return reply.code(400).send({ error: "image field must be named 'image'" })
  if (!allowedImageAnalysisMimeTypes.has(inputFile.mimetype)) {
    return reply.code(415).send({ error: `unsupported image type: ${inputFile.mimetype}` })
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of inputFile.file) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += data.byteLength
    if (totalBytes > 10 * 1024 * 1024) {
      return reply.code(413).send({ error: "image file is too large (max 10MB)" })
    }
    chunks.push(data)
  }
  if (totalBytes === 0) return reply.code(400).send({ error: "image file is empty" })

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const model = process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o"
  const base64 = Buffer.concat(chunks).toString("base64")
  const dataUrl = `data:${inputFile.mimetype};base64,${base64}`

  try {
    const completion = await client.chat.completions.create({
      model,
      ...openAIChatOptionsForModel(model),
      messages: [
        {
          role: "system",
          content:
            "You interpret pasted screenshots for a website editing assistant. Return one concise sentence describing the most actionable visual/context clue the editor should know. No markdown."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this screenshot and provide concise context for a website edit instruction." },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    })

    const text = (completion.choices[0]?.message?.content ?? "").trim()
    if (!text) {
      return reply.code(502).send({ error: "image interpretation failed", detail: "No text returned." })
    }
    return {
      text,
      model,
      bytes: totalBytes,
      mimeType: inputFile.mimetype
    }
  } catch (error) {
    return reply.code(502).send({ error: "image interpretation failed", detail: toErrorDetail(error) })
  }
})

app.get("/chat/stream", async (request, reply) => {
  const query = request.query as ChatRequestBody
  const scopedQuery: ChatRequestBody = { ...query, session: scopedSessionKey(query.session, query.siteId) }
  const origin = request.headers.origin ?? "*"

  reply.raw.setHeader("Content-Type", "text/event-stream")
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform")
  reply.raw.setHeader("Connection", "keep-alive")
  reply.raw.setHeader("X-Accel-Buffering", "no")
  reply.raw.setHeader("Access-Control-Allow-Origin", origin)
  reply.raw.setHeader("Vary", "Origin")

  reply.raw.write("retry: 60000\n\n")
  sseWrite(reply, { type: "status", message: "Crafting your update..." })
  const result = await runChatPipeline(pipelineCtx, scopedQuery, {
    onPlanningToken: (token) => sseWrite(reply, { type: "token", text: token }),
    onOpApplied: (event) =>
      // The editor consumes op_applied as patch-transport input for incremental preview updates.
      sseWrite(reply, {
        type: "op_applied",
        index: event.index,
        total: event.total,
        op: event.op,
        previewVersion: event.previewVersion,
        focusBlockId: event.focusBlockId ?? null
      })
  })
  if (result.code >= 400) {
    sseWrite(reply, { type: "error", result: result.payload, code: result.code })
    reply.raw.end()
    return reply
  }

  sseWrite(reply, { type: "final", result: result.payload })
  reply.raw.end()
  return reply
})

app.post("/history/undo", async (request, reply) => {
  const body = request.body as { session?: string; siteId?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })
  const session = scopedSessionKey(body.session, body.siteId)

  const undoMap = getHistoryMap(historyUndo, session)
  const redoMap = getHistoryMap(historyRedo, session)
  const list = undoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to undo" })

  const current = getPage(session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const prev = list.pop()
  undoMap.set(body.slug, list)
  if (!prev) return reply.code(400).send({ error: "nothing to undo" })

  const redoList = redoMap.get(body.slug) ?? []
  redoList.push(structuredClone(current))
  redoMap.set(body.slug, redoList)

  setPage(session, structuredClone(prev))
  const previewVersion = bumpVersion(session)
  schedulePersistState(app.log)
  return { status: "applied", previewVersion }
})

app.post("/history/redo", async (request, reply) => {
  const body = request.body as { session?: string; siteId?: string; slug?: string }
  if (!body.session || !body.slug) return reply.code(400).send({ error: "session and slug are required" })
  const session = scopedSessionKey(body.session, body.siteId)

  const undoMap = getHistoryMap(historyUndo, session)
  const redoMap = getHistoryMap(historyRedo, session)
  const list = redoMap.get(body.slug) ?? []
  if (list.length === 0) return reply.code(400).send({ error: "nothing to redo" })

  const current = getPage(session, body.slug)
  if (!current) return reply.code(404).send({ error: "page not found" })

  const next = list.pop()
  redoMap.set(body.slug, list)
  if (!next) return reply.code(400).send({ error: "nothing to redo" })

  const undoList = undoMap.get(body.slug) ?? []
  undoList.push(structuredClone(current))
  undoMap.set(body.slug, undoList)

  setPage(session, structuredClone(next))
  const previewVersion = bumpVersion(session)
  schedulePersistState(app.log)
  return { status: "applied", previewVersion }
})

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => ({
  plannerSource: process.env.OPENAI_API_KEY ? "openai" : "demo",
  unsplashConfigured: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim())
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
