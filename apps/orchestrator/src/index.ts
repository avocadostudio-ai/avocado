import dotenv from "dotenv"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { resolve } from "node:path"
import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import OpenAI from "openai"
import { toFile } from "openai/uploads"
import { z } from "zod"
import {
  allowedBlockTypes,
  blockSchemas,
  demoPublishedPages,
  editPlanSchema,
  getPropDisplayName,
  operationSchema,
  type BlockType,
  type EditPlan,
  type Operation,
  type PageDoc,
  validateBlockProps
} from "@ai-site-editor/shared"
import { type UnsplashImage, type UnsplashResolveOptions } from "./variation-images.js"
import {
  extractRouteMentions,
  firstRouteMention,
  isLikelyClarificationFollowUp,
  isStandalonePageOperation,
  normalizeRouteCandidate,
  parseCreatePageRequest,
  toSeedSlug
} from "./nlp/intent-helpers.js"

const app = Fastify({ logger: true })

const envCandidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]
for (const path of envCandidates) {
  if (existsSync(path)) {
    dotenv.config({ path })
    break
  }
}
const execFileAsync = promisify(execFile)

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

const publishedPages = new Map<string, PageDoc>()
for (const page of demoPublishedPages()) publishedPages.set(page.slug, structuredClone(page))

const draftPages = new Map<string, Map<string, PageDoc>>()
const historyUndo = new Map<string, Map<string, PageDoc[]>>()
const historyRedo = new Map<string, Map<string, PageDoc[]>>()
const versions = new Map<string, number>()
const recentEdits = new Map<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>()
const pendingClarificationBySession = new Map<string, { baseRequest: string; updatedAt: string }>()
type PublishTracker = {
  session: string
  status: "triggered" | "failed"
  startedAt: string
  updatedAt: string
  slugs: string[]
  deployStatus?: number
  deployResponse?: string
  inspectUrl?: string
  deploymentId?: string
  deploymentUrl?: string
  vercelState?: string
  lastCheckError?: string
}
const publishStatusBySession = new Map<string, PublishTracker>()
const stateFilePath = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../.data/orchestrator-state.json")
const chatTelemetryFilePath = process.env.CHAT_TELEMETRY_FILE ?? resolve(process.cwd(), "../../.data/chat-telemetry.ndjson")
const generatedImageDir = process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? resolve(process.cwd(), "../../.data/generated-images")
const orchestratorPublicOrigin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")
const chatStrictPrimaryOpMode = /^(1|true|yes|on)$/i.test((process.env.CHAT_STRICT_PRIMARY_OP_MODE ?? "").trim())
const chatTelemetryLimit = Number(process.env.CHAT_TELEMETRY_LIMIT ?? 500)
let persistTimer: NodeJS.Timeout | null = null
let telemetryFlushTimer: NodeJS.Timeout | null = null

type ChatTelemetryPhase =
  | "received"
  | "forced_plan"
  | "plan_attempt_failed"
  | "plan_generated"
  | "plan_apply_failed"
  | "repair_attempt"
  | "repair_generated"
  | "result"

type ChatTelemetryEntry = {
  id: string
  at: string
  phase: ChatTelemetryPhase
  session: string
  requestedSlug: string
  effectiveSlug: string
  plannerSource: "openai" | "demo"
  modelKey: ModelKey
  modelUsed: string
  promptHash: string
  promptExcerpt: string
  promptLength: number
  outcome?: string
  reason?: string
  reasonCategory?: GuardrailErrorCategory
  opCount?: number
  opTypes?: string[]
  intent?: EditPlan["intent"]
}

const chatTelemetryBuffer: ChatTelemetryEntry[] = []
const chatTelemetryPendingWrites: ChatTelemetryEntry[] = []

function shouldPersistTelemetry() {
  return !/^(0|false|no|off)$/i.test((process.env.CHAT_TELEMETRY_PERSIST ?? "1").trim())
}

async function flushTelemetryNow() {
  if (!shouldPersistTelemetry()) return
  if (chatTelemetryPendingWrites.length === 0) return
  const pending = chatTelemetryPendingWrites.splice(0, chatTelemetryPendingWrites.length)
  const lines = pending.map((item) => JSON.stringify(item)).join("\n")
  await mkdir(resolve(chatTelemetryFilePath, ".."), { recursive: true })
  await appendFile(chatTelemetryFilePath, `${lines}\n`, "utf8")
}

function scheduleTelemetryFlush() {
  if (telemetryFlushTimer) clearTimeout(telemetryFlushTimer)
  telemetryFlushTimer = setTimeout(() => {
    void flushTelemetryNow().catch((error: unknown) => {
      app.log.error({ err: toErrorDetail(error), file: chatTelemetryFilePath }, "Failed to flush chat telemetry")
    })
  }, 150)
}

async function loadTelemetryFromDisk() {
  if (!shouldPersistTelemetry()) return
  if (!existsSync(chatTelemetryFilePath)) return
  try {
    const raw = await readFile(chatTelemetryFilePath, "utf8")
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean)
    const tail = lines.slice(-Math.max(chatTelemetryLimit, 100))
    chatTelemetryBuffer.length = 0
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as ChatTelemetryEntry
        if (!parsed || typeof parsed !== "object") continue
        if (typeof parsed.id !== "string" || typeof parsed.phase !== "string") continue
        chatTelemetryBuffer.push(parsed)
      } catch {
        // Skip malformed telemetry lines.
      }
    }
    app.log.info({ file: chatTelemetryFilePath, loaded: chatTelemetryBuffer.length }, "Loaded chat telemetry")
  } catch (error) {
    app.log.error({ err: toErrorDetail(error), file: chatTelemetryFilePath }, "Failed to load chat telemetry")
  }
}

function telemetryPromptExcerpt(message: string) {
  return message.replace(/\s+/g, " ").trim().slice(0, 180)
}

function telemetryPromptHash(message: string) {
  return createHash("sha256").update(message).digest("hex").slice(0, 16)
}

function pushChatTelemetry(entry: ChatTelemetryEntry) {
  chatTelemetryBuffer.push(entry)
  if (chatTelemetryBuffer.length > chatTelemetryLimit) {
    chatTelemetryBuffer.splice(0, chatTelemetryBuffer.length - chatTelemetryLimit)
  }
  if (shouldPersistTelemetry()) {
    chatTelemetryPendingWrites.push(entry)
    scheduleTelemetryFlush()
  }
  app.log.info(
    {
      event: "chat_telemetry",
      id: entry.id,
      phase: entry.phase,
      session: entry.session,
      requestedSlug: entry.requestedSlug,
      effectiveSlug: entry.effectiveSlug,
      plannerSource: entry.plannerSource,
      modelKey: entry.modelKey,
      modelUsed: entry.modelUsed,
      promptHash: entry.promptHash,
      promptLength: entry.promptLength,
      outcome: entry.outcome,
      reasonCategory: entry.reasonCategory,
      opCount: entry.opCount,
      opTypes: entry.opTypes
    },
    "Chat telemetry event"
  )
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

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

function firstUrlFromText(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"']+/)
  return match ? match[0] : undefined
}

function normalizeUnsplashQuery(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

function extractUnsplashQuery(message: string) {
  const aboutBeforeFromUnsplash = message.match(/\b(?:about|of|with|for)\s+([^,.!?;\n]+?)\s+from\s+unsplash\b/i)
  const fromUnsplashMatch = message.match(/\bfrom\s+unsplash\b[^.?!\n]*?(?:showing|of|with|for)?\s*([^,.!?;\n]+)/i)
  const unsplashMatch = message.match(/\bunsplash\b[^.?!\n]*?(?:showing|of|with|for)\s+([^,.!?;\n]+)/i)
  const quoted = /"([^"]+)"/.exec(message)?.[1]
  const candidate = aboutBeforeFromUnsplash?.[1] ?? fromUnsplashMatch?.[1] ?? unsplashMatch?.[1] ?? quoted
  if (!candidate) return undefined
  const cleaned = candidate
    .replace(/\b(an?|the)\s+/gi, "")
    .replace(/\b(image|photo|picture)\b/gi, "")
    .replace(/\b(of|with|showing|for)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const normalized = normalizeUnsplashQuery(cleaned)
  return normalized.length > 0 ? normalized : undefined
}

function heroImageQueryFromContext(args: {
  message: string
  currentPage: PageDoc
  targetBlock: PageDoc["blocks"][number]
  patchCandidate?: Record<string, unknown>
}) {
  const explicit = extractUnsplashQuery(args.message)
  if (explicit) return explicit

  const patch = args.patchCandidate
  const patchHeading = typeof patch?.heading === "string" ? patch.heading : ""
  const patchSubheading = typeof patch?.subheading === "string" ? patch.subheading : ""
  const patchAlt = typeof patch?.imageAlt === "string" ? patch.imageAlt : ""

  const targetProps = args.targetBlock.props as Record<string, unknown>
  const heading = typeof targetProps.heading === "string" ? targetProps.heading : ""
  const subheading = typeof targetProps.subheading === "string" ? targetProps.subheading : ""
  const alt = typeof targetProps.imageAlt === "string" ? targetProps.imageAlt : ""

  const candidates = [patchAlt, patchHeading, patchSubheading, heading, subheading, alt, args.currentPage.title]
    .map((entry) => normalizeUnsplashQuery(entry))
    .filter(Boolean)

  for (const candidate of candidates) {
    const terms = imageKeywordsFromQuery(candidate, 4)
    if (terms.length > 0) return terms.join(" ")
  }

  const fallback = normalizeUnsplashQuery(args.currentPage.title || args.targetBlock.type || "hero image")
  return fallback || "hero image"
}

const IMAGE_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "background",
  "backgrounds",
  "different",
  "for",
  "from",
  "image",
  "images",
  "of",
  "on",
  "photo",
  "photos",
  "picture",
  "pictures",
  "the",
  "types",
  "unsplash",
  "various",
  "varied",
  "with"
])

function imageKeywordsFromQuery(raw: string, max = 3): string[] {
  const tokens = normalizeUnsplashQuery(raw)
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !IMAGE_QUERY_STOPWORDS.has(part))
  const unique = Array.from(new Set(tokens))
  return unique.slice(0, max)
}

type VariationImageIntent = {
  baseQuery: string
  subjectKeywords: string[]
  varyBackgrounds: boolean
  styleTerms: string[]
  provider: "unsplash" | "llm"
  backgroundTerms: string[]
}

function deriveVariationImageIntent(args: { message: string; block: PageDoc["blocks"][number] }): VariationImageIntent {
  const fromMessage = extractUnsplashQuery(args.message)
  const props = args.block.props as Record<string, unknown>
  const headingLike =
    typeof props.heading === "string"
      ? props.heading
      : typeof props.title === "string"
        ? props.title
        : typeof props.subheading === "string"
          ? props.subheading
          : ""
  const fallback = normalizeUnsplashQuery([headingLike, args.block.type].filter(Boolean).join(" "))
  const baseQuery = fromMessage ?? (fallback.length > 0 ? fallback : "abstract hero background")

  const lowerMessage = args.message.toLowerCase()
  const varyBackgrounds =
    /\bdifferent\s+(?:types?\s+of\s+)?backgrounds?\b/.test(lowerMessage) ||
    /\bunique\s+backgrounds?\b/.test(lowerMessage) ||
    /\bvaried\s+backgrounds?\b/.test(lowerMessage) ||
    /\bvarious\s+backgrounds?\b/.test(lowerMessage)

  const styleTerms: string[] = []
  if (/\bclose[\s-]?up\b/.test(lowerMessage) || /\bmacro\b/.test(lowerMessage)) styleTerms.push("close up")
  if (/\bstudio\b/.test(lowerMessage)) styleTerms.push("studio lighting")
  if (/\bfood\b/.test(lowerMessage) || /\bproduct\b/.test(lowerMessage)) styleTerms.push("food photography")
  if (/\bdark\b/.test(lowerMessage)) styleTerms.push("dark moody")
  if (/\bminimal\b/.test(lowerMessage)) styleTerms.push("minimal")
  if (/\boutdoor\b/.test(lowerMessage) || /\bnature\b/.test(lowerMessage)) styleTerms.push("natural light")

  const backgroundTerms = Array.from(
    new Set(
      Array.from(lowerMessage.matchAll(/\b(?:background|backgrounds)\s+(?:like|such as|with|in)?\s*([a-z0-9\s-]{3,45})/gi))
        .map((match) => normalizeUnsplashQuery(match[1] ?? ""))
        .filter(Boolean)
    )
  ).slice(0, 5)

  const provider: "unsplash" | "llm" =
    /\bunsplash\b/.test(lowerMessage)
      ? "unsplash"
      : /\b(llm|openai|ai[-\s]?generated|generated backgrounds?|synthetic backgrounds?)\b/.test(lowerMessage)
        ? "llm"
        : "unsplash"

  return {
    baseQuery,
    subjectKeywords: imageKeywordsFromQuery(baseQuery, 4),
    varyBackgrounds,
    styleTerms,
    provider,
    backgroundTerms
  }
}

function buildVariationImageQuery(intent: VariationImageIntent, variationIndex: number): string {
  const base = [intent.baseQuery, ...intent.styleTerms].filter(Boolean).join(" ")
  if (!intent.varyBackgrounds) return normalizeUnsplashQuery(base)
  const backgrounds = ["studio background", "wood table background", "kitchen background", "dark background", "outdoor background"]
  const chosen = backgrounds[variationIndex % backgrounds.length]
  return normalizeUnsplashQuery(`${base} ${chosen}`)
}

function buildVariationImagePrompt(args: {
  intent: VariationImageIntent
  blockType: string
  variationIndex: number
}): string {
  const fallbackBackgrounds = [
    "clean neutral studio gradient",
    "cozy wooden table scene",
    "bright kitchen countertop",
    "dark cinematic backdrop",
    "outdoor natural light"
  ]
  const customBackgrounds = args.intent.backgroundTerms
  const backgrounds = customBackgrounds.length > 0 ? customBackgrounds : fallbackBackgrounds
  const chosenBackground = args.intent.varyBackgrounds ? backgrounds[args.variationIndex % backgrounds.length] : backgrounds[0]
  const subject = args.intent.baseQuery || `${args.blockType} hero visual`
  const style = args.intent.styleTerms.length > 0 ? args.intent.styleTerms.join(", ") : "natural product photography"

  return [
    "Use case: precise-object-edit",
    `Asset type: website ${args.blockType} image`,
    `Primary request: create a high-quality hero image featuring ${subject}`,
    `Scene/background: ${chosenBackground}`,
    `Style/medium: ${style}`,
    "Composition/framing: landscape composition with clear focal subject and breathing room",
    "Lighting/mood: clean, editorial, realistic",
    "Constraints: no text, no logos, no watermark",
    "Avoid: clutter, over-saturation, distorted objects"
  ].join("\n")
}

async function generateVariationImageWithOpenAI(args: {
  prompt: string
  altText: string
}): Promise<UnsplashImage | null> {
  if (!process.env.OPENAI_API_KEY) return null

  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1"
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const result = await client.images.generate({
      model,
      prompt: args.prompt,
      size: "1536x1024"
    })

    const image = result.data?.[0]
    let bytes: Buffer | null = null

    if (typeof image?.b64_json === "string" && image.b64_json.length > 0) {
      bytes = Buffer.from(image.b64_json, "base64")
    } else if (typeof image?.url === "string" && image.url.length > 0) {
      const fetched = await fetch(image.url)
      if (fetched.ok) {
        const arrayBuffer = await fetched.arrayBuffer()
        bytes = Buffer.from(arrayBuffer)
      }
    }

    if (!bytes || bytes.byteLength === 0) return null

    await mkdir(generatedImageDir, { recursive: true })
    const fileName = `var_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    await writeFile(resolve(generatedImageDir, fileName), bytes)

    return {
      url: `${orchestratorPublicOrigin}/generated-images/${fileName}`,
      alt: args.altText,
      query: args.prompt
    }
  } catch {
    return null
  }
}

async function resolveUnsplashImage(
  query: string,
  options?: UnsplashResolveOptions,
  logContext?: { chatRequestId?: string }
): Promise<UnsplashImage | null> {
  const safeQuery = normalizeUnsplashQuery(query)
  if (!safeQuery) return null
  const variationIndex =
    typeof options?.variationIndex === "number" && Number.isInteger(options.variationIndex) && options.variationIndex >= 0
      ? options.variationIndex
      : 0
  const page = variationIndex + 1

  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim()
  app.log.info(
    {
      event: "hero_image_resolve_start",
      chatRequestId: logContext?.chatRequestId,
      query: safeQuery,
      variationIndex,
      hasUnsplashKey: Boolean(accessKey),
      subjectKeywords: options?.subjectKeywords ?? []
    },
    "Resolving hero image candidate"
  )
  if (accessKey) {
    try {
      const endpoint = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(safeQuery)}&orientation=landscape&per_page=8&page=1&content_filter=high`
      const res = await fetch(endpoint, {
        headers: {
          Authorization: `Client-ID ${accessKey}`,
          "Accept-Version": "v1"
        }
      })

      type UnsplashResult = {
        alt_description?: unknown
        description?: unknown
        urls?: { regular?: unknown; full?: unknown }
      }
      function toImage(result: UnsplashResult | undefined): UnsplashImage | null {
        const baseUrl =
          typeof result?.urls?.regular === "string"
            ? result.urls.regular
            : typeof result?.urls?.full === "string"
              ? result.urls.full
              : undefined
        if (!baseUrl) return null
        const joiner = baseUrl.includes("?") ? "&" : "?"
        const url = `${baseUrl}${joiner}auto=format&fit=crop&w=1600&q=80`
        const altCandidate =
          typeof result?.alt_description === "string"
            ? result.alt_description
            : typeof result?.description === "string"
              ? result.description
              : ""
        return {
          url,
          alt: altCandidate.trim() || `Unsplash photo of ${safeQuery}`,
          query: safeQuery
        }
      }

      if (res.ok) {
        const payload = (await res.json()) as { results?: UnsplashResult[] }
        const list = Array.isArray(payload.results) ? payload.results : []
        const subjectKeywords =
          Array.isArray(options?.subjectKeywords) && options?.subjectKeywords.length > 0
            ? options.subjectKeywords.map((k) => k.toLowerCase())
            : imageKeywordsFromQuery(safeQuery, 2)
        const usedImageUrls = options?.usedImageUrls
        const matched = subjectKeywords.length > 0
          ? list.filter((item) => {
            const haystack = `${typeof item.alt_description === "string" ? item.alt_description : ""} ${
              typeof item.description === "string" ? item.description : ""
            }`.toLowerCase()
            return subjectKeywords.some((keyword) => haystack.includes(keyword))
          })
          : []
        const ordered = matched.length > 0 ? [...matched, ...list.filter((item) => !matched.includes(item))] : list
        for (const item of ordered) {
          const next = toImage(item)
          if (!next) continue
          if (usedImageUrls && usedImageUrls.has(next.url)) continue
          app.log.info(
            {
              event: "hero_image_resolve_success",
              chatRequestId: logContext?.chatRequestId,
              provider: "unsplash_api",
              query: safeQuery,
              url: next.url,
              alt: next.alt
            },
            "Resolved hero image from Unsplash API"
          )
          return next
        }
      }
    } catch {
      // Fall through to source URL fallback.
      app.log.warn(
        {
          event: "hero_image_resolve_unsplash_error",
          chatRequestId: logContext?.chatRequestId,
          query: safeQuery
        },
        "Unsplash API lookup failed; falling back to seeded source"
      )
    }
  }

  const seed = toSeedSlug(`${safeQuery}-${page}`) || "hero-image"
  const sourceUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/1600/900`
  app.log.warn(
    {
      event: "hero_image_resolve_fallback",
      chatRequestId: logContext?.chatRequestId,
      provider: "picsum_seed",
      query: safeQuery,
      seed,
      url: sourceUrl
    },
    "Falling back to picsum seeded hero image"
  )
  return {
    url: sourceUrl,
    alt: `Photo for ${safeQuery}`,
    query: safeQuery
  }
}

function deploymentIdFromAny(input: string): string | undefined {
  const match = input.match(/\b(dpl_[a-zA-Z0-9]+)\b/)
  return match?.[1]
}

async function refreshPublishStatusFromVercel(current: PublishTracker) {
  const token = process.env.VERCEL_TOKEN?.trim()
  if (!token || !current.deploymentId) return current

  const teamId = process.env.VERCEL_TEAM_ID?.trim()
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""
  try {
    const res = await fetch(`https://api.vercel.com/v13/deployments/${current.deploymentId}${query}`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!res.ok) {
      current.lastCheckError = `vercel_api_${res.status}`
      current.updatedAt = new Date().toISOString()
      return current
    }

    const payload = (await res.json()) as { readyState?: unknown; url?: unknown; inspectorUrl?: unknown }
    const readyState = typeof payload.readyState === "string" ? payload.readyState.toUpperCase() : undefined
    const url = typeof payload.url === "string" && payload.url.length > 0 ? `https://${payload.url}` : undefined
    const inspectorUrl = typeof payload.inspectorUrl === "string" && payload.inspectorUrl.length > 0 ? payload.inspectorUrl : undefined

    current.vercelState = readyState ?? current.vercelState
    current.deploymentUrl = url ?? current.deploymentUrl
    current.inspectUrl = inspectorUrl ?? current.inspectUrl
    current.lastCheckError = undefined
    current.updatedAt = new Date().toISOString()
    return current
  } catch (error) {
    current.lastCheckError = toErrorDetail(error)
    current.updatedAt = new Date().toISOString()
    return current
  }
}

function requirePublishToken(request: { headers: Record<string, unknown> }) {
  const configured = process.env.PUBLISH_TOKEN?.trim()
  if (!configured) return true
  const provided = String(request.headers["x-publish-token"] ?? "").trim()
  return provided.length > 0 && provided === configured
}

async function runGit(args: string[], cwd: string) {
  try {
    const result = await execFileAsync("git", args, { cwd })
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  } catch (error) {
    const maybe = error as { stdout?: string; stderr?: string; message?: string }
    const stderr = (maybe.stderr ?? "").trim()
    const stdout = (maybe.stdout ?? "").trim()
    const message = (maybe.message ?? "").trim()
    const detail = stderr || stdout || message || toErrorDetail(error)
    throw new Error(detail)
  }
}

function sanitizeBranch(input: string) {
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : "main"
}

async function publishViaGit(session: string) {
  const repoRoot = resolve(process.cwd(), "../..")
  const targetPath = "apps/site/lib/published-content.json"
  const absoluteTargetPath = resolve(repoRoot, targetPath)
  const branch = sanitizeBranch(process.env.PUBLISH_GIT_BRANCH ?? "main")
  const strict = process.env.PUBLISH_GIT_STRICT === "1"
  const pages = getSessionPages(session)
  const slugs = pages.map((page) => page.slug)
  const payload = `${JSON.stringify(pages, null, 2)}\n`

  await writeFile(absoluteTargetPath, payload, "utf8")

  const statusRaw = await runGit(["status", "--porcelain"], repoRoot)
  const statusLines = statusRaw.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)

  if (strict) {
    const blocking = statusLines.filter((line) => !line.endsWith(` ${targetPath}`) && !line.endsWith(` ${targetPath.replace(/\//g, "\\/")}`))
    if (blocking.length > 0) {
      return {
        status: "failed" as const,
        session,
        slugs,
        reason: "working_tree_not_clean",
        details: blocking.slice(0, 12)
      }
    }
  }

  await runGit(["add", targetPath], repoRoot)
  try {
    await runGit(["diff", "--cached", "--quiet", "--", targetPath], repoRoot)
    return {
      status: "ready" as const,
      session,
      slugs,
      branch,
      message: "No content changes to publish."
    }
  } catch {
    // Expected when there are staged changes for targetPath.
  }

  const commitMessage = `publish: session ${session} ${new Date().toISOString()}`

  try {
    await runGit(["commit", "-m", commitMessage], repoRoot)
  } catch (error) {
    const detail = toErrorDetail(error)
    if (detail.includes("nothing to commit")) {
      return {
        status: "ready" as const,
        session,
        slugs,
        branch,
        message: "No content changes to publish."
      }
    }
    return {
      status: "failed" as const,
      session,
      slugs,
      reason: "commit_failed",
      details: [detail]
    }
  }

  let headSha = ""
  try {
    const rev = await runGit(["rev-parse", "HEAD"], repoRoot)
    headSha = rev.stdout.trim()
  } catch {
    // Ignore; commit succeeded.
  }

  try {
    await runGit(["push", "origin", branch], repoRoot)
    return {
      status: "triggered" as const,
      session,
      slugs,
      branch,
      commitSha: headSha || undefined,
      vercelState: "TRIGGERED"
    }
  } catch (error) {
    return {
      status: "failed" as const,
      session,
      slugs,
      branch,
      commitSha: headSha || undefined,
      reason: "push_failed",
      details: [toErrorDetail(error)]
    }
  }
}

function ensureHeroImageProps(page: PageDoc) {
  for (const block of page.blocks) {
    if (block.type !== "Hero") continue
    const props = block.props as Record<string, unknown>
    if (typeof props.imageUrl !== "string" || props.imageUrl.length === 0) {
      props.imageUrl = "/hero-generated.svg"
    }
    if (typeof props.imageAlt !== "string" || props.imageAlt.length === 0) {
      props.imageAlt = page.slug === "/pricing" ? "Abstract generated illustration for the pricing hero" : "Abstract generated illustration for the hero section"
    }
  }
}

const modelLookup = {
  fast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o-mini",
  balanced: process.env.OPENAI_MODEL_BALANCED ?? "gpt-4o",
  reasoning: process.env.OPENAI_MODEL_REASONING ?? "o1",
  codex: process.env.OPENAI_MODEL_CODEX ?? "o3"
} as const

type ModelKey = keyof typeof modelLookup
const DEFAULT_SITE_ID = "avocado-stories"
const DEFAULT_SESSION = "dev"

function normalizeSiteId(value: unknown) {
  if (typeof value !== "string") return DEFAULT_SITE_ID
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || DEFAULT_SITE_ID
}

function normalizeSession(value: unknown) {
  if (typeof value !== "string") return DEFAULT_SESSION
  const cleaned = value.trim()
  return cleaned || DEFAULT_SESSION
}

function scopedSessionKey(session: unknown, siteId: unknown) {
  const normalizedSession = normalizeSession(session)
  const normalizedSiteId = normalizeSiteId(siteId)
  if (normalizedSiteId === "avocado-stories" || normalizedSiteId === "default") {
    // Keep Avocado Stories on legacy session keys so existing content is preserved.
    return normalizedSession
  }
  return `${normalizedSiteId}::${normalizedSession}`
}

type ChatRequestBody = {
  session?: string
  siteId?: string
  sitePurpose?: string
  siteHosting?: string
  slug?: string
  message?: string
  modelKey?: ModelKey
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

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

type ChatResult = {
  status: string
  summary: string
  changes: string[]
  mentionedSlugs?: string[]
  suggestions?: string[]
  validationErrors?: unknown
  previewVersion: number
  focusBlockId?: string
  updatedSlug?: string
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
  debug?: {
    traceId: string
    promptHash: string
    promptExcerpt: string
    outcome?: string
    reasonCategory?: GuardrailErrorCategory
    intent?: EditPlan["intent"]
    opTypes?: string[]
    opCount?: number
  }
}

type VariationRequestBody = {
  session?: string
  siteId?: string
  sitePurpose?: string
  siteHosting?: string
  slug?: string
  message?: string
  modelKey?: ModelKey
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

type VariationOption = {
  id: string
  title: string
  summary: string
  patch: Record<string, unknown>
  changedKeys: string[]
}

type VariationResult = {
  status: "ok"
  summary: string
  blockId: string
  blockType: BlockType
  pageSlug: string
  baseProps: Record<string, unknown>
  variations: VariationOption[]
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}

const DEFAULT_VARIATION_COUNT = 3
const MAX_VARIATION_COUNT = 12

function requestedVariationCount(message: string): number {
  const normalized = message.toLowerCase().replace(/-/g, " ")
  const numberMatch = normalized.match(/\b(\d{1,2})\s+variations?\b/)
  if (numberMatch) {
    const parsed = Number.parseInt(numberMatch[1], 10)
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_VARIATION_COUNT)
  }

  const wordsToNumbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12
  }
  for (const [word, value] of Object.entries(wordsToNumbers)) {
    const re = new RegExp(`\\b${word}\\s+variations?\\b`, "i")
    if (re.test(normalized)) return value
  }
  return DEFAULT_VARIATION_COUNT
}

function openAIChatOptionsForModel(model: string) {
  // o-series and gpt-5 family reject temperature in chat.completions; omit to use model default.
  const lower = model.toLowerCase()
  if (lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || lower.startsWith("gpt-5")) return {}
  return { temperature: 0 as const }
}

function isResponsesOnlyModel(_model: string) {
  // No current OpenAI model requires the Responses API exclusively; all supported models
  // use chat.completions. Update this if a future model mandates the Responses API.
  return false
}

function extractResponsesOutputText(response: unknown) {
  const direct = (response as { output_text?: unknown } | null)?.output_text
  if (typeof direct === "string" && direct.length > 0) return direct

  const output = (response as { output?: unknown } | null)?.output
  if (!Array.isArray(output)) return ""

  const chunks: string[] = []
  for (const item of output as Array<{ content?: unknown }>) {
    if (!item || typeof item !== "object") continue
    const content = item.content
    if (!Array.isArray(content)) continue
    for (const part of content as Array<{ text?: unknown; type?: unknown }>) {
      if (!part || typeof part !== "object") continue
      if (part.type === "output_text" && typeof part.text === "string") chunks.push(part.text)
    }
  }
  return chunks.join("")
}

// Shared normaliser used by all intent detectors below.
function normalizeForIntent(message: string) {
  return message.toLowerCase().replace(/\s+/g, " ").trim()
}

// Single source of truth for block-catalog query patterns.
const BLOCK_CATALOG_PATTERNS: RegExp[] = [
  /\bwhat\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
  /\bwhich\s+(other\s+)?blocks?\s+can\s+(you|i)\s+add\b/,
  /\bwhat\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
  /\bwhich\s+(other\s+)?block\s+types?\s+can\s+(you|i)\s+add\b/,
  /\bwhat\s+else\s+can\s+i\s+add\b/,
  /\bwhat\s+other\s+content\b/,
  /\bavailable\s+blocks?\b/,
  /\bavailable\s+block\s+types?\b/
]

function isBlockCatalogQuery(message: string) {
  const m = normalizeForIntent(message)
  return BLOCK_CATALOG_PATTERNS.some((re) => re.test(m))
}

function isInfoQuery(message: string) {
  const m = normalizeForIntent(message)
  return (
    BLOCK_CATALOG_PATTERNS.some((re) => re.test(m)) ||
    /\bwhat\s+can\s+i\s+(change|edit)\b/.test(m) ||
    /\bwhat\s+content\b/.test(m) ||
    /\bcontent\s+elements?\b/.test(m) ||
    /\b(which|what)\s+fields?\b/.test(m) ||
    /\bwhat\s+prop(ertie)?s?\b/.test(m)
  )
}

function isAdviceQuery(message: string) {
  const m = normalizeForIntent(message)
  return (
    /\b(is it good|is this good|should (we|i)|do you recommend|would you recommend)\b/.test(m) ||
    /\bwhat do you think\b/.test(m) ||
    /\bwhat (can|should) be improved\b/.test(m) ||
    /\bhow can (this|the) page be improved\b/.test(m) ||
    /\bhow (can|should) i improve (this|the) page\b/.test(m) ||
    /\bimprovements?\b/.test(m) ||
    /\bis faq\b/.test(m) ||
    /\bshould .*faq\b/.test(m) ||
    /\bgood idea\b/.test(m)
  )
}

function adviceResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args
  const message = (body.message ?? "").toLowerCase()
  const pageLabel = current.slug === "/" ? "this home page" : `this page (${current.slug})`
  const hasFaq = current.blocks.some((block) => block.type === "FAQAccordion")
  const hasHero = current.blocks.some((block) => block.type === "Hero")
  const hasCta = current.blocks.some((block) => block.type === "CTA")

  if (/\bfaq\b/.test(message)) {
    const summary = hasFaq
      ? `Yes, FAQ can work on ${pageLabel}, but keep it concise and near the bottom so it supports decisions without distracting from the main content.`
      : `FAQ is usually a good fit on ${pageLabel} when visitors may have objections (pricing, process, trust, support).`
    const changes = hasFaq
      ? ["Current state: FAQ already exists on this page.", "Recommendation: keep 3-6 high-intent questions."]
      : ["Current state: no FAQ block detected on this page.", "Recommendation: add a compact FAQ section near the bottom."]
    return {
      code: 200,
      payload: {
        status: "advice",
        summary,
        changes,
        suggestions: hasFaq
          ? ["Move FAQ to bottom", "Rewrite FAQ questions for this audience", "Keep FAQ, but reduce to 4 questions"]
          : ["Add FAQ section with 4 questions at the bottom", "Add FAQ below testimonials", "Skip FAQ on this page"],
        mentionedSlugs: [current.slug],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const summary = `It depends on the page goal. For ${pageLabel}, prioritize a clear Hero, supporting proof, and one strong CTA before adding extra sections.`
  const changes = [
    hasHero ? "Hero is present." : "Hero is missing.",
    hasCta ? "CTA is present." : "CTA is missing."
  ]
  return {
    code: 200,
    payload: {
      status: "advice",
      summary,
      changes,
      suggestions: [
        "Add testimonials below Hero",
        "Add FAQ at the bottom",
        "Strengthen the main CTA copy"
      ],
      mentionedSlugs: [current.slug],
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

function plannerMessageWithPendingContext(session: string, message: string) {
  const pending = pendingClarificationBySession.get(session)
  if (!pending) return message
  if (isStandalonePageOperation(message)) return message
  if (!isLikelyClarificationFollowUp(message)) return message
  return `${pending.baseRequest}\nClarification from user: ${message}`
}

function withSiteContext(message: string, sitePurpose?: string, siteHosting?: string) {
  const purpose = typeof sitePurpose === "string" ? sitePurpose.trim() : ""
  const hosting = typeof siteHosting === "string" ? siteHosting.trim() : ""
  if (!purpose && !hosting) return message
  const lines: string[] = []
  if (purpose) lines.push(`Site purpose: ${purpose}`)
  if (hosting) lines.push(`Hosting context: ${hosting}`)
  return `${message}\n\n[site context]\n${lines.join("\n")}\n[/site context]`
}

function extractAudienceTarget(message: string) {
  const lower = message.toLowerCase()
  const patternMatches = [
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,80}?)\s+(?:audience|users?|customers?|buyers?|founders?|teams?|developers?|marketers?|parents?|students?)\b/),
    lower.match(/\bfor\s+([a-z0-9 ,&/-]{2,80})$/),
    lower.match(/\btarget(?:ing)?\s+([a-z0-9 ,&/-]{2,80})\b/)
  ]
  const raw = patternMatches.find(Boolean)?.[1]
  if (!raw) return undefined
  const cleaned = raw
    .replace(/\b(an?|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
  return cleaned.length > 1 ? cleaned : undefined
}

function titleCaseWords(text: string) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
}

function addAudienceSuffix(value: string, audience: string) {
  const normalized = value.trim()
  if (!normalized) return normalized
  const audienceRe = new RegExp(`\\b${audience.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
  if (audienceRe.test(normalized)) return normalized
  return `${normalized} for ${audience}`
}

function audiencePatchForBlock(block: PageDoc["blocks"][number], audience: string) {
  const props = block.props as Record<string, unknown>
  if (block.type === "Hero") {
    const heading = typeof props.heading === "string" ? props.heading : ""
    const subheading = typeof props.subheading === "string" ? props.subheading : ""
    const nextHeading = addAudienceSuffix(heading, audience)
    const nextSubheading = addAudienceSuffix(subheading, audience)
    const patch: Record<string, unknown> = {}
    if (nextHeading && nextHeading !== heading) patch.heading = nextHeading
    if (nextSubheading && nextSubheading !== subheading) patch.subheading = nextSubheading
    return patch
  }
  if (block.type === "RichText") {
    const body = typeof props.body === "string" ? props.body : ""
    const nextBody = body.toLowerCase().includes(audience.toLowerCase()) ? body : `For ${audience}: ${body}`
    return nextBody !== body ? { body: nextBody } : {}
  }
  if (block.type === "CTA") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  if (block.type === "FeatureGrid" || block.type === "Testimonials" || block.type === "FAQAccordion" || block.type === "CardGrid" || block.type === "Card") {
    const title = typeof props.title === "string" ? props.title : ""
    const nextTitle = addAudienceSuffix(title, audience)
    return nextTitle !== title ? { title: nextTitle } : {}
  }
  return {}
}

function nextAvailableSlug(session: string, baseSlug: string) {
  const draft = getSessionDraft(session)
  if (!draft.has(baseSlug)) return baseSlug
  let idx = 2
  while (draft.has(`${baseSlug}-${idx}`)) idx += 1
  return `${baseSlug}-${idx}`
}

function buildCreatePagePlan(args: { session: string; requestedSlug: string; assumptions?: string[] }) {
  const normalizedRequested = normalizeRouteCandidate(args.requestedSlug)
  if (!normalizedRequested || normalizedRequested === "/") return null
  const draft = getSessionDraft(args.session)
  if (draft.has(normalizedRequested)) {
    return {
      intent: "needs_clarification",
      summary_for_user: `Page ${normalizedRequested} already exists. Provide a different page path.`,
      change_log: args.assumptions ?? [],
      ops: []
    } satisfies EditPlan
  }

  const seed = toSeedSlug(normalizedRequested.replace(/^\//, "") || "new-page") || "new-page"
  const now = new Date().toISOString()
  const page: PageDoc = {
    id: pageIdFromSlug(normalizedRequested),
    slug: normalizedRequested,
    title: pageTitleFromSlug(normalizedRequested),
    updatedAt: now,
    blocks: [
      {
        id: `b_hero_${seed}`,
        type: "Hero",
        props: defaultPropsForType("Hero")
      }
    ]
  }
  return {
    intent: "edit_plan",
    summary_for_user: `Created page ${normalizedRequested}.`,
    change_log: [...(args.assumptions ?? []), `Created new page ${normalizedRequested}.`],
    ops: [{ op: "create_page", page }]
  } satisfies EditPlan
}

function editablePropsFromBlock(block: PageDoc["blocks"][number]) {
  if (!block || !block.props || typeof block.props !== "object") return []
  return Object.keys(block.props as Record<string, unknown>)
}

function promptFromPropKey(propKey: string) {
  const labels: Record<string, string> = {
    heading: "Change heading to \"...\"",
    subheading: "Change subheading to \"...\"",
    ctaText: "Change CTA text to \"...\"",
    ctaHref: "Change CTA link to \"/...\"",
    imageUrl: "Update hero image (e.g. from Unsplash: cherries)",
    imageAlt: "Change image alt text to \"...\"",
    secondaryCtaText: "Add secondary CTA button \"...\"",
    secondaryCtaHref: "Change secondary CTA link to \"/...\"",
    body: "Edit body text to \"...\"",
    title: "Change title to \"...\"",
    description: "Change description to \"...\"",
    features: "Update feature list",
    items: "Update items",
    cards: "Update cards"
  }
  return labels[propKey] ?? `Change ${propKey} to \"...\"`
}

function userFacingPropNames(blockType: BlockType, keys: string[]) {
  return keys.map((key) => getPropDisplayName(blockType, key))
}

function childSuggestions(args: { selected: PageDoc["blocks"][number]; editablePath: string }) {
  const { selected, editablePath } = args
  const path = editablePath.trim()
  if (!path) return []
  const root = path.split(".")[0] ?? path

  if (selected.type === "CardGrid" && root.startsWith("cards[")) {
    return [
      `Update ${root}.title to \"...\"`,
      `Update ${root}.description to \"...\"`,
      `Update ${root}.ctaText to \"...\"`,
      `Update ${root}.ctaHref to \"/...\"`
    ]
  }

  if (selected.type === "FeatureGrid" && root.startsWith("features[")) {
    return [`Update ${root}.title to \"...\"`, `Update ${root}.description to \"...\"`]
  }

  if (selected.type === "Testimonials" && root.startsWith("items[")) {
    return [`Update ${root}.quote to \"...\"`, `Update ${root}.author to \"...\"`]
  }

  if (selected.type === "FAQAccordion" && root.startsWith("items[")) {
    return [`Update ${root}.q to \"...\"`, `Update ${root}.a to \"...\"`]
  }

  return [`Update ${root} ...`]
}

function infoResponse(args: {
  body: ChatRequestBody
  current: PageDoc
  plannerSource: "openai" | "demo"
  modelUsed: string
  modelKey: ModelKey
}): { code: number; payload: ChatResult } {
  const { body, current, plannerSource, modelUsed, modelKey } = args
  const lower = (body.message ?? "").toLowerCase()

  if (isBlockCatalogQuery(body.message ?? "")) {
    return {
      code: 200,
      payload: {
        status: "info",
        summary: `You can add these block types: ${allowedBlockTypes.join(", ")}.`,
        changes: ["Tip: specify position, e.g. “add Testimonials below Hero”."],
        suggestions: [
          "Add Testimonials below Hero",
          "Add CardGrid at the end",
          "Add FeatureGrid after Hero",
          "Add FAQAccordion before CTA",
          "Add CTA at the end"
        ],
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const selected =
    body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
      ? current.blocks.find((b) => b.id === body.activeBlockId)
      : null

  if (selected) {
    const keys = editablePropsFromBlock(selected)
    const childPath = String(body.activeEditablePath ?? "")
    const suggestions = childPath ? childSuggestions({ selected, editablePath: childPath }) : keys.slice(0, 4).map(promptFromPropKey)
    const summary = childPath
      ? `Focused ${selected.type} item: ${childPath}.`
      : `You can edit ${selected.type} fields: ${keys.join(", ")}.`
    return {
      code: 200,
      payload: {
        status: "info",
        summary,
        changes: childPath
          ? [`Selected block: ${selected.id}`, `Focused path: ${childPath}`]
          : [`Selected block: ${selected.id}`, "Tip: click a field name in your prompt, e.g. “change heading to …”."],
        suggestions,
        previewVersion: versions.get(body.session ?? "dev") ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }
    }
  }

  const firstByType = new Map<BlockType, PageDoc["blocks"][number]>()
  for (const block of current.blocks) {
    if (!firstByType.has(block.type)) firstByType.set(block.type, block)
  }
  const byType = Array.from(firstByType.values()).map((b) => `${b.type}: ${editablePropsFromBlock(b).join(", ")}`)
  return {
    code: 200,
    payload: {
      status: "info",
      summary: "Select a block to get precise editable fields. Current page supports:",
      changes: byType,
      previewVersion: versions.get(body.session ?? "dev") ?? 0,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

function getSessionDraft(session: string) {
  let sessionMap = draftPages.get(session)
  if (!sessionMap) {
    sessionMap = new Map<string, PageDoc>()
    for (const [slug, page] of publishedPages) {
      const copy = structuredClone(page)
      ensureHeroImageProps(copy)
      sessionMap.set(slug, copy)
    }
    draftPages.set(session, sessionMap)
  }
  return sessionMap
}

function getHistoryMap(store: Map<string, Map<string, PageDoc[]>>, session: string) {
  let bySession = store.get(session)
  if (!bySession) {
    bySession = new Map<string, PageDoc[]>()
    store.set(session, bySession)
  }
  return bySession
}

function getPage(session: string, slug: string) {
  const sessionDraft = getSessionDraft(session)
  return sessionDraft.get(slug) ?? null
}

function getSessionPages(session: string) {
  const draft = getSessionDraft(session)
  const slugs = orderSlugsHomeFirst(Array.from(draft.keys()))
  return slugs.map((slug) => structuredClone(draft.get(slug)!))
}

function setPage(session: string, page: PageDoc) {
  const sessionDraft = getSessionDraft(session)
  ensureHeroImageProps(page)
  sessionDraft.set(page.slug, page)
}

function pushUndo(session: string, slug: string, snapshot: PageDoc) {
  const undoMap = getHistoryMap(historyUndo, session)
  const list = undoMap.get(slug) ?? []
  list.push(structuredClone(snapshot))
  undoMap.set(slug, list)

  const redoMap = getHistoryMap(historyRedo, session)
  redoMap.set(slug, [])
}

function bumpVersion(session: string) {
  const current = versions.get(session) ?? 0
  const next = current + 1
  versions.set(session, next)
  return next
}

function pushRecentEdit(session: string, entry: { slug: string; summary: string; ops: Operation[] }) {
  const list = recentEdits.get(session) ?? []
  list.push({ ...entry, at: new Date().toISOString() })
  recentEdits.set(session, list.slice(-10))
}

type PersistedState = {
  publishedPages: PageDoc[]
  draftPages: Record<string, Record<string, PageDoc>>
  historyUndo: Record<string, Record<string, PageDoc[]>>
  historyRedo: Record<string, Record<string, PageDoc[]>>
  versions: Record<string, number>
  recentEdits: Record<string, Array<{ slug: string; summary: string; ops: Operation[]; at: string }>>
}

function nestedPageMapToObject(source: Map<string, Map<string, PageDoc>>) {
  const out: Record<string, Record<string, PageDoc>> = {}
  for (const [session, pages] of source) {
    out[session] = {}
    for (const [slug, page] of pages) out[session][slug] = structuredClone(page)
  }
  return out
}

function nestedHistoryMapToObject(source: Map<string, Map<string, PageDoc[]>>) {
  const out: Record<string, Record<string, PageDoc[]>> = {}
  for (const [session, bySlug] of source) {
    out[session] = {}
    for (const [slug, snapshots] of bySlug) out[session][slug] = snapshots.map((item) => structuredClone(item))
  }
  return out
}

function objectToNestedPageMap(source: unknown) {
  const out = new Map<string, Map<string, PageDoc>>()
  if (!source || typeof source !== "object") return out
  for (const [session, pages] of Object.entries(source as Record<string, unknown>)) {
    if (!pages || typeof pages !== "object") continue
    const bySlug = new Map<string, PageDoc>()
    for (const [slug, page] of Object.entries(pages as Record<string, unknown>)) {
      if (!page || typeof page !== "object") continue
      bySlug.set(slug, page as PageDoc)
    }
    out.set(session, bySlug)
  }
  return out
}

function objectToNestedHistoryMap(source: unknown) {
  const out = new Map<string, Map<string, PageDoc[]>>()
  if (!source || typeof source !== "object") return out
  for (const [session, bySlugRaw] of Object.entries(source as Record<string, unknown>)) {
    if (!bySlugRaw || typeof bySlugRaw !== "object") continue
    const bySlug = new Map<string, PageDoc[]>()
    for (const [slug, listRaw] of Object.entries(bySlugRaw as Record<string, unknown>)) {
      if (!Array.isArray(listRaw)) continue
      bySlug.set(slug, listRaw.filter((item) => item && typeof item === "object") as PageDoc[])
    }
    out.set(session, bySlug)
  }
  return out
}

async function persistStateNow() {
  const payload: PersistedState = {
    publishedPages: Array.from(publishedPages.values()).map((page) => structuredClone(page)),
    draftPages: nestedPageMapToObject(draftPages),
    historyUndo: nestedHistoryMapToObject(historyUndo),
    historyRedo: nestedHistoryMapToObject(historyRedo),
    versions: Object.fromEntries(versions.entries()),
    recentEdits: Object.fromEntries(recentEdits.entries())
  }
  await mkdir(resolve(stateFilePath, ".."), { recursive: true })
  await writeFile(stateFilePath, JSON.stringify(payload), "utf8")
}

function schedulePersistState() {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void persistStateNow().catch((error: unknown) => {
      app.log.error({ err: toErrorDetail(error) }, "Failed to persist orchestrator state")
    })
  }, 80)
}

async function loadStateFromDisk() {
  if (!existsSync(stateFilePath)) return
  try {
    const raw = await readFile(stateFilePath, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedState>

    if (Array.isArray(parsed.publishedPages) && parsed.publishedPages.length > 0) {
      publishedPages.clear()
      for (const page of parsed.publishedPages) {
        if (!page || typeof page !== "object" || typeof page.slug !== "string") continue
        ensureHeroImageProps(page as PageDoc)
        publishedPages.set(page.slug, page as PageDoc)
      }
    }

    draftPages.clear()
    for (const [session, bySlug] of objectToNestedPageMap(parsed.draftPages)) {
      for (const page of bySlug.values()) ensureHeroImageProps(page)
      draftPages.set(session, bySlug)
    }

    historyUndo.clear()
    for (const [session, bySlug] of objectToNestedHistoryMap(parsed.historyUndo)) historyUndo.set(session, bySlug)

    historyRedo.clear()
    for (const [session, bySlug] of objectToNestedHistoryMap(parsed.historyRedo)) historyRedo.set(session, bySlug)

    versions.clear()
    if (parsed.versions && typeof parsed.versions === "object") {
      for (const [session, value] of Object.entries(parsed.versions)) {
        if (typeof value === "number" && Number.isFinite(value)) versions.set(session, value)
      }
    }

    recentEdits.clear()
    if (parsed.recentEdits && typeof parsed.recentEdits === "object") {
      for (const [session, listRaw] of Object.entries(parsed.recentEdits)) {
        if (!Array.isArray(listRaw)) continue
        const list = listRaw
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => entry as { slug: string; summary: string; ops: Operation[]; at: string })
        recentEdits.set(session, list.slice(-10))
      }
    }

    app.log.info({ file: stateFilePath }, "Loaded persisted orchestrator state")
  } catch (error) {
    app.log.error({ err: toErrorDetail(error), file: stateFilePath }, "Failed to load persisted orchestrator state")
  }
}

function getRecentEdits(session: string, slug: string) {
  const list = recentEdits.get(session) ?? []
  return list
    .filter((item) => item.slug === slug)
    .slice(-3)
    .map((item) => ({
      at: item.at,
      summary: item.summary,
      ops: item.ops.map((op) => op.op)
    }))
}

function clarificationSuggestions(args: { body: ChatRequestBody; current: PageDoc; selected?: PageDoc["blocks"][number] | null }) {
  const { selected } = args
  if (selected) {
    const keys = editablePropsFromBlock(selected)
    if (keys.length > 0) return keys.slice(0, 4).map(promptFromPropKey)
    return [
      `Update ${selected.type} title to "..."`,
      `Move ${selected.type} to bottom`,
      `Remove selected block`
    ]
  }
  return [
    "Change heading to \"...\"",
    "Add Testimonials below Hero",
    "Move FAQ to bottom",
    "Remove selected block"
  ]
}

function demoPlanFromMessage(message: string, slug: string, activeBlockId?: string, activeBlockType?: string): EditPlan {
  const lower = message.toLowerCase()
  const quoted = /"([^"]+)"/.exec(message)?.[1]

  if (lower.includes("make this shorter") && activeBlockId && activeBlockType === "Hero") {
    return {
      intent: "edit_plan",
      summary_for_user: "Shortened the selected hero copy.",
      change_log: ["Updated hero heading and subheading to be more concise."],
      ops: [
        {
          op: "update_props",
          pageSlug: slug,
          blockId: activeBlockId,
          patch: {
            heading: "Edit your site in seconds",
            subheading: "Describe a change and preview it instantly."
          }
        }
      ]
    }
  }

  if ((lower.includes("title") || lower.includes("heading")) && activeBlockId && activeBlockType === "Hero") {
    const headingText =
      quoted ??
      message
        .replace(/change/i, "")
        .replace(/hero/i, "")
        .replace(/title/i, "")
        .replace(/heading/i, "")
        .replace(/\bto\b/i, "")
        .trim()

    if (headingText) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the hero title.",
        change_log: [`Changed hero heading to "${headingText}".`],
        ops: [
          {
            op: "update_props",
            pageSlug: slug,
            blockId: activeBlockId,
            patch: { heading: headingText }
          }
        ]
      }
    }
  }

  if (lower.includes("rich text") || lower.includes("richtext") || lower.includes("text block") || lower.includes("prose")) {
    if (lower.includes("add") || lower.includes("insert") || lower.includes("create")) {
      return {
        intent: "edit_plan",
        summary_for_user: "Added a rich text section.",
        change_log: ["Inserted RichText block."],
        ops: [
          {
            op: "add_block",
            pageSlug: slug,
            block: {
              id: `b_richtext_${Date.now()}`,
              type: "RichText",
              props: {
                title: "",
                body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
              }
            }
          }
        ]
      }
    }
    if (activeBlockId && activeBlockType === "RichText" && quoted) {
      return {
        intent: "edit_plan",
        summary_for_user: "Updated the rich text body.",
        change_log: [`Set body to "${quoted}".`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: activeBlockId, patch: { body: quoted } }]
      }
    }
  }

  if (lower.includes("add testimonials")) {
    return {
      intent: "edit_plan",
      summary_for_user: "Added a testimonials section below the hero.",
      change_log: ["Inserted Testimonials block after the hero section."],
      ops: [
        {
          op: "add_block",
          pageSlug: slug,
          afterBlockId: "b_hero_home",
          block: {
            id: `b_testimonials_${Date.now()}`,
            type: "Testimonials",
            props: {
              title: "Loved by small teams",
              items: [
                { quote: "We launched in a day.", author: "Ana, Founder" },
                { quote: "Edits are now effortless.", author: "Chris, Marketer" }
              ]
            }
          }
        }
      ]
    }
  }

  if (lower.includes("remove") && activeBlockId) {
    return {
      intent: "edit_plan",
      summary_for_user: "Removed the selected block.",
      change_log: ["Deleted selected section from the page."],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: activeBlockId }]
    }
  }

  return {
    intent: "needs_clarification",
    summary_for_user: "I need one clarification: what section should I change and what exactly should be updated?",
    change_log: [],
    ops: []
  }
}

function extractJsonObject(input: string) {
  const start = input.indexOf("{")
  const end = input.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  return input.slice(start, end + 1)
}

function normalizeOpName(op: unknown) {
  if (typeof op !== "string") return op
  const key = op.toLowerCase().replace(/[\s-]/g, "_")
  const aliases: Record<string, Operation["op"]> = {
    create: "create_page",
    create_page: "create_page",
    createpage: "create_page",
    add: "add_block",
    add_block: "add_block",
    addblock: "add_block",
    insert_block: "add_block",
    insertblock: "add_block",
    update: "update_props",
    update_props: "update_props",
    updateprops: "update_props",
    update_block: "update_props",
    updateblock: "update_props",
    edit_block: "update_props",
    editblock: "update_props",
    remove: "remove_block",
    remove_block: "remove_block",
    removeblock: "remove_block",
    delete: "remove_block",
    delete_block: "remove_block",
    deleteblock: "remove_block",
    move: "move_block",
    move_block: "move_block",
    moveblock: "move_block",
    reorder_block: "move_block",
    reorderblock: "move_block",
    duplicate_block: "duplicate_block",
    duplicateblock: "duplicate_block",
    copy_block: "duplicate_block",
    copyblock: "duplicate_block",
    clone_block: "duplicate_block",
    cloneblock: "duplicate_block",
    add_item: "add_item",
    additem: "add_item",
    insert_item: "add_item",
    insertitem: "add_item",
    append_item: "add_item",
    appenditem: "add_item",
    update_item: "update_item",
    updateitem: "update_item",
    edit_item: "update_item",
    edititem: "update_item",
    remove_item: "remove_item",
    removeitem: "remove_item",
    delete_item: "remove_item",
    deleteitem: "remove_item",
    move_item: "move_item",
    moveitem: "move_item",
    reorder_item: "move_item",
    reorderitem: "move_item",
    move_page: "move_page",
    movepage: "move_page",
    reorder_page: "move_page",
    reorderpage: "move_page",
    duplicate_page: "duplicate_page",
    duplicatepage: "duplicate_page",
    copy_page: "duplicate_page",
    copypage: "duplicate_page",
    clone_page: "duplicate_page",
    clonepage: "duplicate_page",
    rename: "rename_page",
    rename_page: "rename_page",
    renamepage: "rename_page",
    remove_page: "remove_page",
    removepage: "remove_page",
    delete_page: "remove_page",
    deletepage: "remove_page"
  }
  return aliases[key] ?? op
}

function orderSlugsHomeFirst(slugs: string[]) {
  return slugs.includes("/") ? ["/", ...slugs.filter((route) => route !== "/")] : slugs
}

function isPageRouteRenameRequest(message?: string) {
  if (!message) return false
  const lower = message.toLowerCase()
  const mentionsRoute = lower.includes("slug") || lower.includes("path") || lower.includes("route") || /\/[a-z0-9/_-]*/i.test(message)
  const asksRename =
    lower.includes("rename") ||
    lower.includes("change") ||
    lower.includes("update") ||
    lower.includes("move") ||
    lower.includes("switch")
  const mentionsPage = lower.includes("page") || lower.includes("this page")
  return mentionsRoute && asksRename && mentionsPage
}

function pageIdFromSlug(slug: string) {
  if (slug === "/") return "p_home"
  const core = slug
    .slice(1)
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
  return `p_${core || "page"}`
}

function pageTitleFromSlug(slug: string) {
  if (slug === "/") return "Home"
  const text = slug
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[-_]/g, " "))
    .join(" ")
    .trim()
  if (!text) return "Untitled Page"
  return text
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function remapRouteReference(value: string, fromSlug: string, toSlug: string) {
  if (!value.startsWith("/")) return value
  if (fromSlug === "/") {
    if (value === "/") return toSlug
    if (value.startsWith("/?") || value.startsWith("/#")) return `${toSlug}${value.slice(1)}`
    return value
  }
  if (value === fromSlug) return toSlug
  if (value.startsWith(`${fromSlug}/`) || value.startsWith(`${fromSlug}?`) || value.startsWith(`${fromSlug}#`)) {
    return `${toSlug}${value.slice(fromSlug.length)}`
  }
  return value
}

function rewriteRouteLinksInValue(input: unknown, fromSlug: string, toSlug: string): { value: unknown; changed: boolean } {
  if (typeof input === "string") {
    const mapped = remapRouteReference(input, fromSlug, toSlug)
    return { value: mapped, changed: mapped !== input }
  }

  if (Array.isArray(input)) {
    let changed = false
    const next = input.map((item) => {
      const mapped = rewriteRouteLinksInValue(item, fromSlug, toSlug)
      if (mapped.changed) changed = true
      return mapped.value
    })
    return { value: changed ? next : input, changed }
  }

  if (!input || typeof input !== "object") return { value: input, changed: false }
  const source = input as Record<string, unknown>
  let changed = false
  const next: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && key.toLowerCase().includes("href")) {
      const mapped = remapRouteReference(value, fromSlug, toSlug)
      if (mapped !== value) changed = true
      next[key] = mapped
      continue
    }
    if (typeof value === "string" && key === "body") {
      const rewritten = value.replace(/\]\((\/[^)\s]+)\)/g, (full, routeCandidate: string) => {
        const mapped = remapRouteReference(routeCandidate, fromSlug, toSlug)
        if (mapped !== routeCandidate) return `](${mapped})`
        return full
      })
      if (rewritten !== value) changed = true
      next[key] = rewritten
      continue
    }
    const mapped = rewriteRouteLinksInValue(value, fromSlug, toSlug)
    if (mapped.changed) changed = true
    next[key] = mapped.value
  }

  return { value: changed ? next : input, changed }
}

function rewriteLinksToRenamedPage(page: PageDoc, fromSlug: string, toSlug: string) {
  let changed = false
  const nextBlocks = page.blocks.map((block) => {
    const mapped = rewriteRouteLinksInValue(block.props, fromSlug, toSlug)
    if (!mapped.changed) return block
    changed = true
    return { ...block, props: mapped.value as Record<string, unknown> }
  })
  if (!changed) return { changed: false, page }
  return { changed: true, page: { ...page, blocks: nextBlocks, updatedAt: new Date().toISOString() } }
}

function normalizePlanCandidate(input: unknown, args?: { defaultSlug?: string; currentPage?: PageDoc; userMessage?: string }) {
  if (!input || typeof input !== "object") return input
  const root = input as Record<string, unknown>
  const ops = Array.isArray(root.ops) ? root.ops : Array.isArray(root.operations) ? root.operations : []
  const userMessage = (args?.userMessage ?? "").toLowerCase()
  const requestedRoute = firstRouteMention(args?.userMessage)
  const routeMentions = extractRouteMentions(args?.userMessage)
  const requestedCreateSlug = parseCreatePageRequest(args?.userMessage ?? "")
  const createPageIntent = Boolean(requestedCreateSlug)
  const refersToCurrentPage = /\b(this|current|selected)\s+page\b/.test(userMessage)

  const resolvePageSlug = (candidate: unknown) => {
    const normalized = normalizeRouteCandidate(candidate)
    if (normalized) return normalized

    if (args?.currentPage) {
      if (typeof candidate !== "string") return args?.defaultSlug
      if (candidate === args.currentPage.id) return args.currentPage.slug
      if (candidate.toLowerCase() === "home" && args.currentPage.slug === "/") return "/"
    }

    return args?.defaultSlug
  }

  const beforeToAfter = (beforeId: unknown) => {
    if (!args?.currentPage || typeof beforeId !== "string") return undefined
    const idx = args.currentPage.blocks.findIndex((block) => block.id === beforeId)
    if (idx <= 0) return undefined
    return args.currentPage.blocks[idx - 1]?.id
  }

  let createdPageSlug: string | undefined
  let droppedPageLevelUpdate = false
  const normalizedOps = ops.flatMap((item) => {
    if (!item || typeof item !== "object") return item
    const source = item as Record<string, unknown>
    const raw = { ...source }

    // Accept malformed one-key op objects like { "move_block": { ...fields } }.
    if (!raw.op && !raw.operation && !raw.action && !raw.kind) {
      for (const key of [
        "create_page",
        "add_block",
        "update_props",
        "remove_block",
        "move_block",
        "duplicate_block",
        "add_item",
        "update_item",
        "remove_item",
        "move_item",
        "rename_page",
        "remove_page",
        "move_page",
        "duplicate_page"
      ] as const) {
        const value = source[key]
        if (value && typeof value === "object" && !Array.isArray(value)) {
          Object.assign(raw, value as Record<string, unknown>)
          raw.op = key
          break
        }
      }
    }

    raw.op = normalizeOpName(raw.op ?? raw.operation ?? raw.action ?? raw.kind)
    const rawType =
      raw.type ?? raw.blockType ?? raw.block_type ?? raw.newBlockType ?? raw.new_block_type ?? raw.target_block_type ?? raw.targetBlockType
    const normalizedType =
      typeof rawType === "string"
        ? allowedBlockTypes.find((type) => type.toLowerCase() === rawType.toLowerCase()) ?? inferBlockTypeFromText(rawType)
        : undefined

    const isListOperation = raw.op === "add_item" || raw.op === "update_item" || raw.op === "remove_item" || raw.op === "move_item"
    const pathLooksLikeListKey = typeof raw.path === "string" && !raw.path.startsWith("/")
    raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.page_slug ?? raw.slug ?? raw.page ?? (isListOperation ? undefined : raw.path) ?? raw.route ?? raw.from)
    raw.newPageSlug = normalizeRouteCandidate(
      raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
    )
    if (!raw.blockId) {
      const pathCandidate = typeof raw.path === "string" && raw.path.startsWith("b_") ? raw.path : undefined
      raw.blockId =
        raw.block_id ??
        raw.targetBlockId ??
        raw.target_block_id ??
        raw.sourceBlockId ??
        raw.source_block_id ??
        raw.fromBlockId ??
        raw.from_block_id ??
        raw.id ??
        pathCandidate
    }
    if (!raw.listKey) {
      raw.listKey = raw.list_key ?? raw.arrayKey ?? raw.array_key ?? raw.collection ?? raw.itemsKey ?? raw.items_key
      if (!raw.listKey && isListOperation && pathLooksLikeListKey) raw.listKey = raw.path
      if (!raw.listKey && isListOperation && typeof raw.path === "string") {
        const keyCandidate = raw.path.trim().replace(/^\/+/, "")
        if (keyCandidate && !keyCandidate.includes("/")) raw.listKey = keyCandidate
      }
    }
    if (isListOperation && typeof raw.listKey === "string") raw.listKey = raw.listKey.replace(/^\/+/, "")
    if (isListOperation && typeof raw.listKey === "string" && typeof raw.pageSlug === "string" && raw.pageSlug === `/${raw.listKey}` && args?.defaultSlug) {
      raw.pageSlug = args.defaultSlug
    }
    if (typeof raw.index !== "number") {
      const indexRaw = raw.index ?? raw.itemIndex ?? raw.item_index ?? raw.fromIndex ?? raw.from_index
      const normalizedIndex = typeof indexRaw === "string" ? Number(indexRaw) : indexRaw
      if (typeof normalizedIndex === "number" && Number.isFinite(normalizedIndex)) raw.index = Math.trunc(normalizedIndex)
    }
    if (typeof raw.afterIndex !== "number") {
      const afterIndexRaw = raw.afterIndex ?? raw.after_index ?? raw.toIndex ?? raw.to_index ?? raw.targetIndex ?? raw.target_index
      const normalizedAfter = typeof afterIndexRaw === "string" ? Number(afterIndexRaw) : afterIndexRaw
      if (typeof normalizedAfter === "number" && Number.isFinite(normalizedAfter)) raw.afterIndex = Math.trunc(normalizedAfter)
    }
    if (!raw.item) {
      const sourceItem = raw.newItem ?? raw.new_item ?? raw.value
      if (sourceItem && typeof sourceItem === "object" && !Array.isArray(sourceItem)) raw.item = sourceItem
    }
    if (raw.op === "add_item" && (!raw.item || typeof raw.item !== "object" || Array.isArray(raw.item))) {
      const listKey = typeof raw.listKey === "string" ? raw.listKey.replace(/^\/+/, "") : ""
      const blockId = typeof raw.blockId === "string" ? raw.blockId : ""
      const currentBlock = blockId ? args?.currentPage?.blocks.find((block) => block.id === blockId) : undefined
      const currentProps = currentBlock?.props as Record<string, unknown> | undefined
      const listValue = listKey ? currentProps?.[listKey] : undefined
      const firstItem = Array.isArray(listValue) ? listValue.find((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : undefined
      if (firstItem) {
        raw.item = structuredClone(firstItem as Record<string, unknown>)
      } else if (currentBlock?.type === "FAQAccordion") {
        raw.item = { q: "New question", a: "New answer" }
      } else if (currentBlock?.type === "FeatureGrid") {
        raw.item = { title: "New feature", description: "Feature description" }
      } else if (currentBlock?.type === "Testimonials") {
        raw.item = { quote: "New testimonial", author: "Customer" }
      } else if (currentBlock?.type === "CardGrid") {
        raw.item = { title: "New card", description: "Card description", ctaText: "Learn more", ctaHref: "/" }
      }
    }
    if (!raw.newBlockId) {
      raw.newBlockId = raw.new_block_id ?? raw.targetBlockId ?? raw.target_block_id ?? raw.copiedBlockId ?? raw.copied_block_id
    }
    if (!raw.afterBlockId) {
      raw.afterBlockId =
        raw.after_block_id ?? raw.after ?? raw.insertAfterId ?? beforeToAfter(raw.beforeId ?? raw.insertBeforeId)
    }
    if (!raw.afterPageSlug) {
      raw.afterPageSlug =
        raw.afterPageSlug ??
        raw.after_page_slug ??
        raw.afterPage ??
        raw.after_page ??
        raw.anchorPageSlug ??
        raw.anchor_page_slug ??
        raw.after
    }
    raw.afterPageSlug = resolvePageSlug(raw.afterPageSlug)
    raw.beforePageSlug = resolvePageSlug(raw.beforePageSlug ?? raw.before_page_slug ?? raw.beforePage ?? raw.before_page)
    if (!raw.patch) {
      raw.patch = raw.props ?? raw.changes
    }

    if (
      raw.op === "update_props" &&
      (!raw.blockId || typeof raw.blockId !== "string") &&
      args?.defaultSlug
    ) {
      const patch = patchObject(raw.patch)
      const newSlugFromPatch = normalizeRouteCandidate(patch?.slug ?? patch?.path ?? patch?.route)
      const newSlugFromPath = typeof raw.path === "string" && raw.path.startsWith("/") ? normalizeRouteCandidate(raw.path) : null
      const fromSlugFromMentions = routeMentions[0]
      const toSlugFromMentions = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
      const nextSlug = raw.newPageSlug ?? newSlugFromPatch ?? newSlugFromPath ?? toSlugFromMentions
      const fromSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? fromSlugFromMentions)
      if (fromSlug && nextSlug && fromSlug !== nextSlug) {
        raw.op = "rename_page"
        raw.pageSlug = fromSlug
        raw.newPageSlug = nextSlug
        delete raw.patch
      }
    }

    if (raw.op === "remove_block" && (!raw.blockId || typeof raw.blockId !== "string")) {
      const asksDeletePage = /\b(delete|remove)\b.*\bpage\b/.test(userMessage)
      if (asksDeletePage) {
        raw.op = "remove_page"
        raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      }
    }

    if (raw.op === "rename_page") {
      const nextSlug =
        raw.newPageSlug ??
        normalizeRouteCandidate(raw.path) ??
        normalizeRouteCandidate(raw.route) ??
        normalizeRouteCandidate(raw.slug) ??
        (routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined)
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.fromPageSlug ?? raw.from_page_slug ?? raw.oldSlug ?? routeMentions[0])
      raw.newPageSlug = nextSlug
      if (!raw.newTitle && typeof raw.title === "string" && raw.title.trim().length > 0) raw.newTitle = raw.title.trim()
      if (
        typeof raw.pageSlug === "string" &&
        typeof raw.newPageSlug === "string" &&
        raw.pageSlug === raw.newPageSlug
      ) {
        return null
      }
    }

    if (raw.op === "remove_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
    }

    if (raw.op === "move_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? routeMentions[0] ?? args?.defaultSlug)
      if (!raw.afterPageSlug && raw.beforePageSlug && args?.currentPage) {
        if (raw.beforePageSlug === "/") raw.afterPageSlug = undefined
        else if (raw.beforePageSlug === args.currentPage.slug) raw.afterPageSlug = undefined
      }
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }

    if (raw.op === "duplicate_page") {
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? raw.route ?? raw.from ?? routeMentions[0] ?? args?.defaultSlug)
      raw.newPageSlug = normalizeRouteCandidate(
        raw.newPageSlug ?? raw.new_page_slug ?? raw.targetSlug ?? raw.target_slug ?? raw.toPageSlug ?? raw.to_page_slug ?? raw.to
      )
      if (!raw.afterPageSlug && routeMentions.length >= 2) {
        const lower = userMessage
        if (/\b(after|below|under)\b/.test(lower)) raw.afterPageSlug = routeMentions[1]
      }
    }

    if (raw.op === "duplicate_block") {
      raw.toPageSlug = resolvePageSlug(
        raw.toPageSlug ?? raw.to_page_slug ?? raw.targetPageSlug ?? raw.target_page_slug ?? raw.newPageSlug ?? raw.new_page_slug
      )
    }
    if (!raw.block) {
      raw.block = raw.newBlock ?? raw.new_block
      if (!raw.block && (raw.op === "add_block" || raw.op === "create_page") && normalizedType) {
        const generatedId =
          typeof raw.blockId === "string" && raw.blockId.length > 0
            ? raw.blockId
            : args?.currentPage
              ? nextBlockId(normalizedType, args.currentPage)
              : `b_${String(normalizedType).toLowerCase()}_${Date.now()}`
        const incomingPatch = patchObject(raw.props ?? raw.patch ?? raw.changes) ?? {}
        raw.block = {
          id: generatedId,
          type: normalizedType,
          props: { ...defaultPropsForType(normalizedType), ...incomingPatch }
        }
      }
    }
    if (raw.op === "add_block" && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
      const block = raw.block as Record<string, unknown>
      if ((!block.type || typeof block.type !== "string") && normalizedType) block.type = normalizedType
      if ((!block.props || typeof block.props !== "object" || Array.isArray(block.props)) && (raw.patch || raw.props || raw.changes)) {
        block.props = patchObject(raw.patch ?? raw.props ?? raw.changes) ?? {}
      }
      if ((!block.id || typeof block.id !== "string") && typeof block.type === "string") {
        block.id = `b_${String(block.type).toLowerCase()}_${Date.now()}`
      }
      raw.block = block
    }

    const createSlugCandidate = resolvePageSlug(raw.pageSlug ?? raw.path ?? raw.slug ?? requestedRoute)
    const explicitCreateTarget = createSlugCandidate && createSlugCandidate !== args?.defaultSlug

    // If user asked to create a page and model emitted add_block on a new route, synthesize create_page.
    if (raw.op === "add_block" && createPageIntent && explicitCreateTarget && !createdPageSlug) {
      const createSlug = createSlugCandidate ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const nowIso = new Date().toISOString()

      let firstBlock: PageDoc["blocks"][number] | null = null
      if (raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
        const block = raw.block as Record<string, unknown>
        const typeRaw = typeof block.type === "string" ? block.type : normalizedType
        const blockType =
          typeof typeRaw === "string"
            ? allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
            : undefined
        if (blockType) {
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          firstBlock = { id, type: blockType, props }
        }
      }

      if (!firstBlock) {
        firstBlock = {
          id: `b_hero_${Date.now()}`,
          type: "Hero",
          props: defaultPropsForType("Hero")
        }
      }

      raw.op = "create_page"
      raw.page = {
        id: pageIdFromSlug(createSlug),
        slug: createSlug,
        title: pageTitleFromSlug(createSlug),
        updatedAt: nowIso,
        blocks: [firstBlock]
      } satisfies PageDoc
      raw.pageSlug = createSlug
      createdPageSlug = createSlug
      return raw
    }

    // LLMs sometimes emit create_page when they actually mean add_block.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      !explicitCreateTarget &&
      (raw.block || normalizedType || raw.blockId || raw.patch || raw.props)
    ) {
      raw.op = "add_block"
      raw.pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug)
    }

    // LLMs also emit create_page with blocks[] for existing pages. Convert to add_block sequence.
    if (
      raw.op === "create_page" &&
      !raw.page &&
      Array.isArray(raw.blocks) &&
      raw.blocks.length > 0
    ) {
      const pageSlug = resolvePageSlug(raw.pageSlug ?? raw.path ?? args?.defaultSlug) ?? args?.defaultSlug
      if (!pageSlug) return raw
      const out: Record<string, unknown>[] = []
      let previousId: string | undefined
      for (const candidate of raw.blocks) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
        const block = { ...(candidate as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : ""
        const blockType =
          allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
        if (!blockType) continue
        if (typeof block.id !== "string" || block.id.length === 0) {
          block.id = args?.currentPage ? nextBlockId(blockType, args.currentPage) : `b_${blockType.toLowerCase()}_${Date.now()}`
        }
        if (!block.props || typeof block.props !== "object" || Array.isArray(block.props)) {
          block.props = defaultPropsForType(blockType)
        }
        const addOp: Record<string, unknown> = {
          op: "add_block",
          pageSlug,
          block
        }
        if (previousId) addOp.afterBlockId = previousId
        previousId = block.id as string
        out.push(addOp)
      }
      return out.length > 0 ? out : raw
    }

    // Accept lightweight or partial create_page operations and synthesize a valid PageDoc payload.
    if (raw.op === "create_page") {
      const pageInput =
        raw.page && typeof raw.page === "object" && !Array.isArray(raw.page) ? (raw.page as Record<string, unknown>) : {}
      const pageSlugInput =
        pageInput.slug ?? raw.pageSlug ?? raw.page_slug ?? raw.path ?? raw.slug ?? raw.route ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const slug = resolvePageSlug(pageSlugInput) ?? requestedRoute ?? args?.defaultSlug ?? "/"
      const nowIso = new Date().toISOString()
      const blocks: PageDoc["blocks"] = []
      const shouldTreatAsCurrentPageEdit =
        !requestedCreateSlug && refersToCurrentPage && !!args?.defaultSlug && slug === args.defaultSlug

      if (Array.isArray(pageInput.blocks)) {
        for (const candidate of pageInput.blocks) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
          const block = candidate as Record<string, unknown>
          const typeRaw = typeof block.type === "string" ? block.type : ""
          const blockType =
            allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
          if (!blockType) continue
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }

      if (shouldTreatAsCurrentPageEdit && blocks.length > 0) {
        let previousId: string | undefined
        const out: Record<string, unknown>[] = []
        for (const block of blocks) {
          const addOp: Record<string, unknown> = { op: "add_block", pageSlug: slug, block }
          if (previousId) addOp.afterBlockId = previousId
          previousId = block.id
          out.push(addOp)
        }
        return out
      }

      if (blocks.length === 0 && raw.block && typeof raw.block === "object" && !Array.isArray(raw.block)) {
        const block = { ...(raw.block as Record<string, unknown>) }
        const typeRaw = typeof block.type === "string" ? block.type : normalizedType
        const blockType =
          typeof typeRaw === "string"
            ? allowedBlockTypes.find((t) => t.toLowerCase() === typeRaw.toLowerCase()) ?? inferBlockTypeFromText(typeRaw)
            : undefined
        if (blockType) {
          const id = typeof block.id === "string" && block.id.length > 0 ? block.id : `b_${blockType.toLowerCase()}_${Date.now()}`
          const props =
            block.props && typeof block.props === "object" && !Array.isArray(block.props)
              ? { ...defaultPropsForType(blockType), ...(block.props as Record<string, unknown>) }
              : defaultPropsForType(blockType)
          blocks.push({ id, type: blockType, props })
        }
      }
      if (shouldTreatAsCurrentPageEdit && blocks.length > 0) {
        raw.op = "add_block"
        raw.pageSlug = slug
        raw.block = blocks[0]
        delete raw.page
        delete raw.page_slug
        delete raw.slug
        delete raw.path
        return raw
      }

      raw.page = {
        id: typeof pageInput.id === "string" && pageInput.id.trim().length > 0 ? pageInput.id.trim() : pageIdFromSlug(slug),
        slug,
        title:
          typeof pageInput.title === "string" && pageInput.title.trim().length > 0 ? pageInput.title.trim() : pageTitleFromSlug(slug),
        updatedAt:
          typeof pageInput.updatedAt === "string" && pageInput.updatedAt.trim().length > 0 ? pageInput.updatedAt.trim() : nowIso,
        blocks
      } satisfies PageDoc
      raw.pageSlug = slug
      createdPageSlug = slug
    }

    // If model mixes create_page + add_block and keeps add_block on the current route, move it to the new route.
    if (raw.op === "add_block" && createPageIntent && createdPageSlug && raw.pageSlug === args?.defaultSlug) {
      raw.pageSlug = createdPageSlug
    }

    // Intent repair: if user asked for bottom/end and model omitted an anchor, place at end.
    if (
      (raw.op === "move_block" || raw.op === "add_block") &&
      !raw.afterBlockId &&
      args?.currentPage &&
      (userMessage.includes("bottom") || userMessage.includes("end") || userMessage.includes("last"))
    ) {
      const movingId =
        typeof raw.blockId === "string"
          ? raw.blockId
          : raw.op === "add_block" && raw.block && typeof raw.block === "object" && typeof (raw.block as { id?: unknown }).id === "string"
            ? (raw.block as { id: string }).id
            : undefined
      const tail = [...args.currentPage.blocks].reverse().find((b) => b.id !== movingId)
      if (tail) raw.afterBlockId = tail.id
    }

    return raw
  })

  const sanitizedOps = normalizedOps.filter((item) => {
    if (!item) return false
    if (typeof item !== "object" || Array.isArray(item)) return true
    const raw = item as Record<string, unknown>
    if (normalizeOpName(raw.op) !== "update_props") return true
    if (typeof raw.blockId === "string" && raw.blockId.length > 0) return true
    const patch = patchObject(raw.patch)
    const hasPageLevelPatch =
      !!patch &&
      (typeof patch.slug === "string" || typeof patch.path === "string" || typeof patch.route === "string" || typeof patch.title === "string")
    const pathLooksLikeRoute = typeof raw.path === "string" && raw.path.startsWith("/")
    if (hasPageLevelPatch || pathLooksLikeRoute) {
      droppedPageLevelUpdate = true
      return false
    }
    return false
  })

  if (droppedPageLevelUpdate && sanitizedOps.length === 0) {
    return {
      ...root,
      intent: "needs_clarification",
      summary_for_user: "I could not infer a valid page operation. Specify the source and target routes explicitly.",
      change_log: [
        "Ignored an invalid page-level update_props operation that was missing blockId.",
        "Try: rename page from /old to /new, or delete page /path."
      ],
      ops: []
    }
  }

  return { ...root, ops: sanitizedOps }
}

function blockContractsSummary() {
  return {
    Hero: {
      allowedProps: ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt", "secondaryCtaText", "secondaryCtaHref"],
      required: ["heading", "subheading", "ctaText", "ctaHref"],
      optional: ["imageUrl", "imageAlt", "secondaryCtaText", "secondaryCtaHref"],
      notes: "Use heading for the main headline; never invent prop names. For imageUrl: prefer a semantically relevant Unsplash image URL (explicit user URL is allowed) and update imageAlt to describe the image. Avoid random placeholder services for topical hero requests. secondaryCtaText/secondaryCtaHref are optional: set them to add a ghost/outline secondary button beside the primary CTA; omit or set to empty string to hide it."
    },
    FeatureGrid: {
      allowedProps: ["title", "features"],
      required: ["title", "features"],
      notes: "features must be a non-empty array of {title, description}."
    },
    Testimonials: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {quote, author}."
    },
    FAQAccordion: {
      allowedProps: ["title", "items"],
      required: ["title", "items"],
      notes: "items must be a non-empty array of {q, a}."
    },
    CTA: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "Keep existing props unless the user asks to change them."
    },
    Card: {
      allowedProps: ["title", "description", "ctaText", "ctaHref"],
      required: ["title", "description", "ctaText", "ctaHref"],
      notes: "A standalone card with one CTA."
    },
    CardGrid: {
      allowedProps: ["title", "cards"],
      required: ["title", "cards"],
      notes: "cards must be a non-empty array of {title, description, ctaText, ctaHref}."
    },
    RichText: {
      allowedProps: ["title", "body"],
      required: ["body"],
      optional: ["title"],
      notes: "body is a string; use \\n\\n to separate paragraphs. Supported inline syntax: **word** for bold, *word* for italic, [text](url) for links, '# Heading' lines become h3 headings. title is an optional section heading. Never invent prop names."
    }
  }
}

function readPathValue(root: unknown, path: string) {
  if (!path) return undefined
  const parts: Array<string | number> = []
  const regex = /([^[.\]]+)|\[(\d+)\]/g
  for (const match of path.matchAll(regex)) {
    if (match[1]) parts.push(match[1])
    if (match[2]) parts.push(Number(match[2]))
  }
  let current: unknown = root
  for (const part of parts) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return undefined
      current = current[part]
      continue
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function selectedBlockSnapshot(args: { currentPage: PageDoc; activeBlockId?: string; activeEditablePath?: string }) {
  if (!args.activeBlockId) return null
  const block = args.currentPage.blocks.find((item) => item.id === args.activeBlockId)
  if (!block) return null
  const editablePath = typeof args.activeEditablePath === "string" && args.activeEditablePath.length > 0 ? args.activeEditablePath : null
  return {
    id: block.id,
    type: block.type,
    props: block.props,
    selectedEditablePath: editablePath,
    selectedEditableValue: editablePath ? readPathValue(block.props, editablePath) ?? null : null
  }
}

const blockTypeEnum = z.enum(allowedBlockTypes as [BlockType, ...BlockType[]])
const intentSchema = z.object({
  action: z.enum(["add", "move", "update", "remove", "info", "clarify"]),
  target_block_ref: z.string().min(1).optional(),
  target_block_type: blockTypeEnum.optional(),
  new_block_type: blockTypeEnum.optional(),
  position: z.enum(["top", "bottom", "before", "after"]).optional(),
  anchor_block_ref: z.string().min(1).optional(),
  patch: z.record(z.unknown()).optional(),
  summary: z.string().min(1).optional(),
  assumption: z.string().min(1).optional()
})
type ParsedIntent = z.infer<typeof intentSchema>

function inferBlockTypeFromText(text: string): BlockType | undefined {
  const normalized = text.toLowerCase()
  if (normalized.includes("hero")) return "Hero"
  if (normalized.includes("featuregrid") || normalized.includes("feature grid") || normalized.includes("features")) return "FeatureGrid"
  if (normalized.includes("testimonial")) return "Testimonials"
  if (normalized.includes("faq")) return "FAQAccordion"
  if (normalized.includes("cta")) return "CTA"
  if (normalized.includes("cardgrid") || normalized.includes("card grid")) return "CardGrid"
  if (normalized.includes("card")) return "Card"
  if (normalized.includes("richtext") || normalized.includes("rich text") || normalized.includes("rich-text") || normalized.includes("prose") || normalized.includes("text block")) return "RichText"
  return undefined
}

function inferAddedBlockTypeFromMessage(message: string): BlockType | undefined {
  const normalized = message.toLowerCase()
  const addMatch = normalized.match(/\b(add|create|insert)\b\s+(?:a|an)?\s*([a-z -]+)/)
  if (!addMatch?.[2]) return undefined
  const chunk = addMatch[2].trim()
  if (chunk.startsWith("card grid") || chunk.startsWith("cardgrid")) return "CardGrid"
  if (chunk.startsWith("card")) return "Card"
  if (chunk.startsWith("feature grid") || chunk.startsWith("featuregrid") || chunk.startsWith("features")) return "FeatureGrid"
  if (chunk.startsWith("testimonial")) return "Testimonials"
  if (chunk.startsWith("faq")) return "FAQAccordion"
  if (chunk.startsWith("cta")) return "CTA"
  if (chunk.startsWith("hero")) return "Hero"
  if (chunk.startsWith("rich text") || chunk.startsWith("richtext") || chunk.startsWith("rich-text") || chunk.startsWith("prose") || chunk.startsWith("text block")) return "RichText"
  return undefined
}

function resolveBlockRef(args: {
  ref?: string
  currentPage: PageDoc
  activeBlockId?: string
  fallbackType?: BlockType
}): PageDoc["blocks"][number] | null {
  const { ref, currentPage, activeBlockId, fallbackType } = args
  const blocks = currentPage.blocks
  if (typeof ref === "string" && ref.length > 0) {
    const exact = blocks.find((b) => b.id === ref)
    if (exact) return exact
    const key = ref.toLowerCase().replace(/[\s_-]/g, "")
    if (["selected", "active", "current", "this"].includes(key) && activeBlockId) {
      const selected = blocks.find((b) => b.id === activeBlockId)
      if (selected) return selected
    }
    const byType = inferBlockTypeFromText(key)
    if (byType) {
      const found = blocks.find((b) => b.type === byType)
      if (found) return found
    }
    const contains = blocks.find((b) => b.id.toLowerCase().includes(key))
    if (contains) return contains
  }

  if (activeBlockId) {
    const selected = blocks.find((b) => b.id === activeBlockId)
    if (selected) return selected
  }
  if (fallbackType) {
    const found = blocks.find((b) => b.type === fallbackType)
    if (found) return found
  }
  return null
}

function ordinalToIndex(value: string) {
  const key = value.toLowerCase()
  if (key === "first" || key === "1st") return 0
  if (key === "second" || key === "2nd") return 1
  if (key === "third" || key === "3rd") return 2
  if (key === "fourth" || key === "4th") return 3
  if (key === "fifth" || key === "5th") return 4
  if (key === "last") return -1
  return null
}

function resolveByDescriptor(args: { descriptor: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { descriptor, currentPage, activeBlockId } = args
  const normalized = descriptor.trim().toLowerCase()
  if (!normalized) return null
  if (["this", "this block", "this section", "selected", "selected block", "current block"].includes(normalized)) {
    if (!activeBlockId) return null
    return currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
  }

  const exact = currentPage.blocks.find((b) => b.id.toLowerCase() === normalized)
  if (exact) return exact

  const type = inferBlockTypeFromText(normalized)
  if (!type) return null
  const typed = currentPage.blocks.filter((b) => b.type === type)
  if (typed.length === 0) return null

  const ord = normalized.match(/\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b/)?.[1]
  const idx = ord ? ordinalToIndex(ord) : 0
  if (idx === null) return typed[0]
  if (idx === -1) return typed[typed.length - 1]
  return typed[idx] ?? typed[0]
}

function resolveReferencesFromMessage(args: { message: string; currentPage: PageDoc; activeBlockId?: string }) {
  const { message, currentPage, activeBlockId } = args
  const lower = message.toLowerCase()

  const mentioned = new Map<string, { id: string; type: BlockType; reason: string }>()
  const addMention = (block: PageDoc["blocks"][number] | null, reason: string) => {
    if (!block) return
    if (!mentioned.has(block.id)) mentioned.set(block.id, { id: block.id, type: block.type, reason })
  }

  if (activeBlockId) {
    const selected = currentPage.blocks.find((b) => b.id === activeBlockId) ?? null
    addMention(selected, "active_selection")
  }

  const descriptorMatches = lower.match(
    /\b(first|second|third|fourth|fifth|last)?\s*(hero|feature grid|features|testimonials?|faq|cta|card grid|card)s?\b/g
  )
  for (const match of descriptorMatches ?? []) {
    addMention(resolveByDescriptor({ descriptor: match, currentPage, activeBlockId }), "descriptor_match")
  }

  for (const block of currentPage.blocks) {
    if (lower.includes(block.id.toLowerCase())) addMention(block, "id_match")
  }

  const afterDescriptor = lower.match(/\b(?:after|below|under)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const beforeDescriptor = lower.match(/\b(?:before|above)\s+([a-z0-9_\-\s]+?)(?:[,.]|$)/)?.[1]?.trim()
  const primaryDescriptor = lower.match(/\b(?:update|change|edit|remove|delete|move)\s+([a-z0-9_\-\s]+?)(?:\b(?:to|into|with|after|before|above|below|under)\b|[,.]|$)/)?.[1]?.trim()

  const anchor = resolveByDescriptor({
    descriptor: afterDescriptor ?? beforeDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  const target = resolveByDescriptor({
    descriptor: primaryDescriptor ?? "",
    currentPage,
    activeBlockId
  })
  addMention(anchor, "anchor_match")
  addMention(target, "target_match")

  return {
    target: target ? { id: target.id, type: target.type } : null,
    anchor: anchor ? { id: anchor.id, type: anchor.type } : null,
    mentionedBlocks: Array.from(mentioned.values()).slice(0, 8)
  }
}

function arrayPropLengths(props: Record<string, unknown>) {
  const out: Record<string, { length: number }> = {}
  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value)) out[key] = { length: value.length }
  }
  return out
}

function pageIntentSummary(args: { slug: string; currentPage: PageDoc }) {
  const { slug, currentPage } = args
  const typeCounts = new Map<string, number>()
  for (const block of currentPage.blocks) {
    typeCounts.set(block.type, (typeCounts.get(block.type) ?? 0) + 1)
  }
  const composition = Array.from(typeCounts.entries())
    .map(([type, count]) => (count > 1 ? `${type} x${count}` : type))
    .join(", ")
  const hero = currentPage.blocks.find((b) => b.type === "Hero")
  const heroHeading = hero && typeof (hero.props as Record<string, unknown>).heading === "string" ? (hero.props as { heading: string }).heading : ""
  const routeLabel = slug === "/" ? "Home page" : `Page ${slug}`
  const headingPart = heroHeading ? ` Hero message: "${heroHeading}".` : ""
  return `${routeLabel} with ${currentPage.blocks.length} blocks (${composition}).${headingPart}`
}

function plannerContextPack(args: {
  session: string
  slug: string
  message: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}) {
  const { session, slug, message, currentPage, activeBlockId, activeBlockType, activeEditablePath } = args
  const pageRoutes = orderSlugsHomeFirst(Array.from(getSessionDraft(session).keys()))
  const selectedIdx = activeBlockId ? currentPage.blocks.findIndex((b) => b.id === activeBlockId) : -1
  const neighbors =
    selectedIdx >= 0
      ? {
          previous: selectedIdx > 0 ? currentPage.blocks[selectedIdx - 1] : null,
          next: selectedIdx < currentPage.blocks.length - 1 ? currentPage.blocks[selectedIdx + 1] : null
        }
      : { previous: null, next: null }

  return {
    route: slug,
    pageRoutes,
    blockCount: currentPage.blocks.length,
    selected: {
      blockId: activeBlockId ?? null,
      blockType: activeBlockType ?? null,
      editablePath: activeEditablePath ?? null,
      block: selectedBlockSnapshot({ currentPage, activeBlockId, activeEditablePath })
    },
    neighbors: {
      previous: neighbors.previous ? { id: neighbors.previous.id, type: neighbors.previous.type } : null,
      next: neighbors.next ? { id: neighbors.next.id, type: neighbors.next.type } : null
    },
    pageOutline: currentPage.blocks.map((b) => {
      const bProps = b.props as Record<string, unknown>
      const arrProps = arrayPropLengths(bProps)
      // Selected block: send full props for precise editing context
      if (b.id === activeBlockId) {
        return { id: b.id, type: b.type, props: structuredClone(bProps), arrayProps: arrProps }
      }
      // Other blocks: scalar props only — keeps token count low
      const scalarProps: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(bProps)) {
        if (!Array.isArray(value) && (typeof value !== "object" || value === null)) {
          scalarProps[key] = value
        }
      }
      return { id: b.id, type: b.type, props: scalarProps, arrayProps: arrProps }
    }),
    pageIntent: pageIntentSummary({ slug, currentPage }),
    recentSuccessfulEdits: getRecentEdits(session, slug),
    resolvedReferences: resolveReferencesFromMessage({ message, currentPage, activeBlockId })
  }
}

function nextBlockId(type: BlockType, page: PageDoc) {
  const base = `b_${type.toLowerCase()}_${Date.now()}`
  if (!page.blocks.some((b) => b.id === base)) return base
  let i = 1
  while (page.blocks.some((b) => b.id === `${base}_${i}`)) i += 1
  return `${base}_${i}`
}

function defaultPropsForType(type: BlockType) {
  if (type === "Hero") {
    return {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Abstract generated illustration"
    }
  }
  if (type === "FeatureGrid") {
    return {
      title: "Key features",
      features: [
        { title: "Fast setup", description: "Launch quickly with guided defaults." },
        { title: "Safe edits", description: "Structured operations keep content valid." },
        { title: "Live updates", description: "Preview changes immediately." }
      ]
    }
  }
  if (type === "Testimonials") {
    return {
      title: "What customers say",
      items: [
        { quote: "We launched faster than expected.", author: "Alex" },
        { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
      ]
    }
  }
  if (type === "FAQAccordion") {
    return {
      title: "Frequently asked questions",
      items: [
        { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
        { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
      ]
    }
  }
  if (type === "Card") {
    return {
      title: "Launch faster",
      description: "Go from idea to published changes in minutes.",
      ctaText: "Learn more",
      ctaHref: "/pricing"
    }
  }
  if (type === "RichText") {
    return {
      title: "",
      body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
    }
  }
  if (type === "CardGrid") {
    return {
      title: "Explore more",
      cards: [
        {
          title: "Fast setup",
          description: "Create and ship updates quickly.",
          ctaText: "Get started",
          ctaHref: "/"
        },
        {
          title: "Safe updates",
          description: "Schema-validated edits reduce breakage.",
          ctaText: "See how",
          ctaHref: "/pricing"
        },
        {
          title: "Team workflow",
          description: "Collaborate with clear, reviewable changes.",
          ctaText: "Read guide",
          ctaHref: "/"
        }
      ]
    }
  }
  return {
    title: "Ready to get started?",
    description: "Apply your next change in seconds.",
    ctaText: "Start now",
    ctaHref: "/"
  }
}

function coercePatchForBlock(block: PageDoc["blocks"][number], rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return {}
  const source =
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
      ? ((rawPatch as { props: Record<string, unknown> }).props as Record<string, unknown>)
      : (rawPatch as Record<string, unknown>)

  const allowed = Object.keys(block.props as Record<string, unknown>)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowed) normalizedToAllowed.set(key.toLowerCase(), key)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.includes(key)) {
      out[key] = value
      continue
    }
    const mapped = normalizedToAllowed.get(key.toLowerCase())
    if (mapped) out[mapped] = value
  }

  if (block.type === "RichText" && typeof out.body === "string") {
    out.body = out.body
      .replace(/\r\n?/g, "\n")
      .replace(/([.!?])([A-Z])/g, "$1 $2")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  return out
}

function sanitizeVariationPatch(block: PageDoc["blocks"][number], patch: unknown): Record<string, unknown> | null {
  const safePatch = coercePatchForBlock(block, patch)
  if (Object.keys(safePatch).length === 0) return null
  const nextProps = { ...(block.props as Record<string, unknown>), ...safePatch }
  const validated = validateBlockProps(block.type as BlockType, nextProps)
  if (!validated.success) return null
  if (JSON.stringify(block.props) === JSON.stringify(validated.data)) return null
  return safePatch
}

function supportsImageVariation(block: PageDoc["blocks"][number]) {
  return Object.prototype.hasOwnProperty.call(block.props, "imageUrl")
}

async function withDefaultImageVariations(args: {
  block: PageDoc["blocks"][number]
  message: string
  variations: VariationOption[]
}): Promise<VariationOption[]> {
  if (!supportsImageVariation(args.block)) return args.variations
  const explicitUrl = firstUrlFromText(args.message)
  const imageIntent = deriveVariationImageIntent({ message: args.message, block: args.block })
  const noDuplicateRequested =
    /\bno\s+duplicates?\b/i.test(args.message) ||
    /\bdo\s+not\s+reuse\b/i.test(args.message) ||
    /\bunique\s+images?\b/i.test(args.message)
  const usedImageUrls = new Set<string>()

  const out: VariationOption[] = []
  for (const [variationIndex, variation] of args.variations.entries()) {
    const patch = { ...variation.patch }
    if (explicitUrl) {
      patch.imageUrl = explicitUrl
      if (!Object.prototype.hasOwnProperty.call(patch, "imageAlt")) {
        patch.imageAlt = `Image for ${args.block.type} variation`
      }
    } else if (imageIntent.provider === "llm") {
      const prompt = buildVariationImagePrompt({
        intent: imageIntent,
        blockType: args.block.type,
        variationIndex
      })
      const generated = await generateVariationImageWithOpenAI({
        prompt,
        altText: `AI-generated ${args.block.type} image variation ${variationIndex + 1}`
      })
      if (generated) {
        patch.imageUrl = generated.url
        if (!Object.prototype.hasOwnProperty.call(patch, "imageAlt")) {
          patch.imageAlt = generated.alt
        }
      }
    } else {
      const query = buildVariationImageQuery(imageIntent, variationIndex)
      const resolved = await resolveUnsplashImage(query, {
        variationIndex,
        subjectKeywords: imageIntent.subjectKeywords,
        usedImageUrls: noDuplicateRequested ? usedImageUrls : undefined
      })
      if (resolved) {
        patch.imageUrl = resolved.url
        usedImageUrls.add(resolved.url)
        if (!Object.prototype.hasOwnProperty.call(patch, "imageAlt")) {
          patch.imageAlt = resolved.alt
        }
      }
    }

    const sanitized = sanitizeVariationPatch(args.block, patch)
    if (!sanitized) continue
    out.push({
      ...variation,
      patch: sanitized,
      changedKeys: Object.keys(sanitized)
    })
  }
  return out
}

function inferVariationTextKey(block: PageDoc["blocks"][number]) {
  const preferred = ["heading", "title", "subheading", "description", "body", "ctaText", "imageAlt"]
  const props = block.props as Record<string, unknown>
  for (const key of preferred) {
    if (typeof props[key] === "string" && (props[key] as string).trim().length > 0) return key
  }
  const firstString = Object.entries(props).find(([, value]) => typeof value === "string" && value.trim().length > 0)
  return firstString?.[0] ?? null
}

function variationConstraints(message: string, block: PageDoc["blocks"][number]) {
  const lower = message.toLowerCase()
  const keepTitle =
    /\bsame\s+title\b/.test(lower) ||
    /\bkeep\s+(the\s+)?title\b/.test(lower) ||
    /\btitle\s+(unchanged|same)\b/.test(lower)
  const cardsOnly =
    block.type === "CardGrid" && (/\bcards?\s+only\b/.test(lower) || /\bonly\s+cards?\b/.test(lower))
  return { keepTitle, cardsOnly }
}

function applyVariationConstraints(args: {
  block: PageDoc["blocks"][number]
  message: string
  patch: Record<string, unknown>
}) {
  const constraints = variationConstraints(args.message, args.block)
  let nextPatch = { ...args.patch }

  if (constraints.keepTitle) {
    delete nextPatch.title
  }
  if (constraints.cardsOnly && args.block.type === "CardGrid") {
    nextPatch = Object.prototype.hasOwnProperty.call(nextPatch, "cards") ? { cards: nextPatch.cards } : {}
  }
  return nextPatch
}

function deterministicCardGridVariations(args: {
  block: PageDoc["blocks"][number]
  count: number
  existing: VariationOption[]
}): VariationOption[] {
  if (args.block.type !== "CardGrid") return []
  const cards = Array.isArray(args.block.props.cards) ? (args.block.props.cards as Array<Record<string, unknown>>) : []
  if (cards.length === 0) return []

  const tones = [
    {
      title: "Crisp",
      summary: "Shorter and more direct card copy.",
      description: (cardTitle: string) => `${cardTitle} essentials in one quick guide.`,
      ctaText: "Explore"
    },
    {
      title: "Benefit-led",
      summary: "Highlights outcomes in every card.",
      description: (cardTitle: string) => `Get practical ${cardTitle.toLowerCase()} tips you can use right away.`,
      ctaText: "See Benefits"
    },
    {
      title: "Action-driven",
      summary: "Pushes a stronger next step.",
      description: (cardTitle: string) => `Start ${cardTitle.toLowerCase()} today with a clear step-by-step plan.`,
      ctaText: "Start Now"
    }
  ]

  const seen = new Set(args.existing.map((item) => JSON.stringify(item.patch)))
  const out: VariationOption[] = []
  for (const tone of tones) {
    if (args.existing.length + out.length >= args.count) break
    const nextCards = cards.map((card) => {
      const title = typeof card.title === "string" && card.title.trim().length > 0 ? card.title.trim() : "Card"
      return {
        ...card,
        description: tone.description(title),
        ctaText: tone.ctaText
      }
    })
    const patch = sanitizeVariationPatch(args.block, { cards: nextCards })
    if (!patch) continue
    const key = JSON.stringify(patch)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: tone.title,
      summary: tone.summary,
      patch,
      changedKeys: Object.keys(patch)
    })
  }
  return out
}

function deterministicVariations(args: {
  block: PageDoc["blocks"][number]
  message: string
  count: number
  existing: VariationOption[]
}): VariationOption[] {
  const { block, count } = args
  if (block.type === "CardGrid") {
    return deterministicCardGridVariations({
      block,
      count,
      existing: args.existing
    })
  }
  const textKey = inferVariationTextKey(block)
  if (!textKey) return []
  const currentValue = String((block.props as Record<string, unknown>)[textKey] ?? "").trim()
  if (!currentValue) return []

  const tones = [
    { title: "Crisp", suffix: " Keep it concise and direct.", summary: "Shorter and more direct copy." },
    { title: "Benefit-led", suffix: " Emphasize the user benefit first.", summary: "Highlights user outcomes." },
    { title: "Action-driven", suffix: " Use a stronger action-oriented tone.", summary: "Adds stronger CTA energy." }
  ]

  const seen = new Set(args.existing.map((item) => JSON.stringify(item.patch)))
  const out: VariationOption[] = []
  for (const tone of tones) {
    if (args.existing.length + out.length >= count) break
    const nextText = `${currentValue.replace(/\s+/g, " ").trim()}${tone.suffix}`
    const patch = sanitizeVariationPatch(block, { [textKey]: nextText })
    if (!patch) continue
    const key = JSON.stringify(patch)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: tone.title,
      summary: tone.summary,
      patch,
      changedKeys: Object.keys(patch)
    })
  }
  return out
}

async function generateVariationsWithOpenAI(args: {
  block: PageDoc["blocks"][number]
  message: string
  model: string
  modelKey: ModelKey
  count: number
}): Promise<VariationOption[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const props = args.block.props as Record<string, unknown>
  const allowedKeys = Object.keys(props)
  const constraints = variationConstraints(args.message, args.block)
  const system = [
    "You generate alternative content variations for one selected website block.",
    "Return ONLY JSON object: {\"variations\":[{\"title\":\"...\",\"summary\":\"...\",\"patch\":{...}}]}",
    `Generate exactly ${args.count} variations.`,
    "Each patch must only include keys from the selected block props.",
    "Each variation must be materially different from the others.",
    "Do not include unchanged values in patch.",
    ...(constraints.keepTitle ? ["Keep the existing block title exactly unchanged."] : []),
    ...(constraints.cardsOnly && args.block.type === "CardGrid" ? ["Patch must include only the 'cards' key."] : []),
    "If selected props include imageUrl, include an image variation (imageUrl and imageAlt) where relevant."
  ].join("\n")

  const user = {
    request: args.message,
    blockId: args.block.id,
    blockType: args.block.type,
    currentProps: props,
    allowedPatchKeys: allowedKeys
  }

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const parsed = parseJsonMaybe(raw) as { variations?: Array<{ title?: unknown; summary?: unknown; patch?: unknown }> } | null
  const list = Array.isArray(parsed?.variations) ? parsed!.variations : []

  const seen = new Set<string>()
  const out: VariationOption[] = []
  for (const item of list) {
    if (out.length >= args.count) break
    const constrainedPatch = applyVariationConstraints({
      block: args.block,
      message: args.message,
      patch: coercePatchForBlock(args.block, item.patch)
    })
    const patch = sanitizeVariationPatch(args.block, constrainedPatch)
    if (!patch) continue
    const patchKey = JSON.stringify(patch)
    if (seen.has(patchKey)) continue
    seen.add(patchKey)
    out.push({
      id: `var_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: typeof item.title === "string" && item.title.trim().length > 0 ? item.title.trim() : `Variation ${out.length + 1}`,
      summary: typeof item.summary === "string" && item.summary.trim().length > 0 ? item.summary.trim() : "Alternative copy direction.",
      patch,
      changedKeys: Object.keys(patch)
    })
  }
  return out
}

function patchObject(rawPatch: unknown) {
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) return null
  if (
    "props" in (rawPatch as Record<string, unknown>) &&
    (rawPatch as { props?: unknown }).props &&
    typeof (rawPatch as { props?: unknown }).props === "object" &&
    !Array.isArray((rawPatch as { props?: unknown }).props)
  ) {
    return (rawPatch as { props: Record<string, unknown> }).props
  }
  return rawPatch as Record<string, unknown>
}

function parseIndexedPath(path: string) {
  const match = /^([a-zA-Z0-9_]+)\[(\d+)\](?:\.(.+))?$/.exec(path.trim())
  if (!match) return null
  return {
    listKey: match[1],
    index: Number(match[2]),
    leaf: match[3]
  }
}

function inferSimpleFieldPatchFromMessage(message: string) {
  const m = message
    .replace(/[“”]/g, '"')
    .match(/\b(?:change|set|update|edit)\b[\s\w]*?\b(title|description|cta\s*text|cta|link|href|quote|author|question|answer|q|a)\b[\s\w]*?\b(?:to|as)\b\s+"?([^"\n]+)"?/i)
  if (!m) return null
  const rawField = m[1].toLowerCase().replace(/\s+/g, "")
  const value = m[2]?.trim()
  if (!value) return null
  const map: Record<string, string> = {
    title: "title",
    description: "description",
    ctatext: "ctaText",
    cta: "ctaText",
    link: "ctaHref",
    href: "ctaHref",
    quote: "quote",
    author: "author",
    question: "q",
    answer: "a",
    q: "q",
    a: "a"
  }
  const key = map[rawField]
  if (!key) return null
  return { [key]: value } as Record<string, unknown>
}

function isRewriteRequest(message: string) {
  const lower = message.toLowerCase()
  return (
    lower.includes("rewrite") ||
    lower.includes("reword") ||
    lower.includes("improve") ||
    lower.includes("simplif") ||
    lower.includes("make this shorter") ||
    lower.includes("shorten")
  )
}

function isTranslationRequest(message: string) {
  const lower = message.toLowerCase()
  return /\btranslate|translation|localiz|in\s+[a-z]+\b/.test(lower)
}

function shouldKeepRichTextTitleOnTranslate(args: {
  target: PageDoc["blocks"][number]
  activeEditablePath?: string
  message: string
  fullPatch: Record<string, unknown>
}) {
  const { target, activeEditablePath, message, fullPatch } = args
  if (target.type !== "RichText") return false
  if (activeEditablePath !== "body") return false
  if (!isTranslationRequest(message)) return false
  return Object.prototype.hasOwnProperty.call(fullPatch, "title")
}

function inferFieldHintFromMessage(message: string, allowedKeys: string[]) {
  const lower = message.toLowerCase()
  const keyMap: Array<{ test: RegExp; key: string }> = [
    { test: /\btitle\b|\bheading\b/, key: "title" },
    { test: /\bdescription\b|\bbody\b|\bcopy\b/, key: "description" },
    { test: /\bcta\s*text\b|\bbutton\s*text\b/, key: "ctaText" },
    { test: /\bcta\s*link\b|\bhref\b|\blink\b|\burl\b/, key: "ctaHref" },
    { test: /\bquote\b/, key: "quote" },
    { test: /\bauthor\b/, key: "author" },
    { test: /\bquestion\b|\bfaq\s*q\b/, key: "q" },
    { test: /\banswer\b|\bfaq\s*a\b/, key: "a" }
  ]

  for (const entry of keyMap) {
    if (entry.test.test(lower) && allowedKeys.includes(entry.key)) return entry.key
  }
  return allowedKeys[0]
}

function rewriteFromExisting(existing: string, message: string) {
  let next = existing
    .replace(/\bamazing\b/gi, "great")
    .replace(/\bincredible\b/gi, "powerful")
    .replace(/\breally\b/gi, "")
    .replace(/\bvery\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()

  if (/short|shorter|concise|brief/i.test(message)) {
    const sentence = next.split(/[.!?]/)[0]?.trim()
    if (sentence) next = sentence.endsWith(".") ? sentence : `${sentence}.`
  }

  if (next === existing) {
    next = existing.endsWith(".") ? `${existing.slice(0, -1)} today.` : `${existing} today.`
  }
  return next
}

function coercePatchForEditablePath(block: PageDoc["blocks"][number], editablePath: string | undefined, rawPatch: unknown, message: string) {
  if (!editablePath) return null
  const directKey = editablePath.trim()
  const blockProps = block.props as Record<string, unknown>
  if (directKey && Object.prototype.hasOwnProperty.call(blockProps, directKey)) {
    const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)
    let value: unknown

    if (source) {
      if (Object.prototype.hasOwnProperty.call(source, directKey)) value = source[directKey]
      else {
        const mapped = Object.keys(source).find((key) => key.toLowerCase() === directKey.toLowerCase())
        if (mapped) value = source[mapped]
      }
    }

    if (value === undefined) {
      const quoted = quotedText(message)
      if (quoted) value = quoted
    }
    if (value === undefined && isRewriteRequest(message)) {
      const existing = blockProps[directKey]
      if (typeof existing === "string" && existing.trim().length > 0) value = rewriteFromExisting(existing, message)
    }
    if (value === undefined) return null

    return {
      patch: { [directKey]: value } as Record<string, unknown>,
      changedKeys: [directKey],
      rootKey: directKey
    }
  }

  const parsed = parseIndexedPath(editablePath)
  if (!parsed) return null

  const list = (block.props as Record<string, unknown>)[parsed.listKey]
  if (!Array.isArray(list) || parsed.index < 0 || parsed.index >= list.length) return null
  const rowRaw = list[parsed.index]
  if (!rowRaw || typeof rowRaw !== "object" || Array.isArray(rowRaw)) return null
  const row = rowRaw as Record<string, unknown>

  const source = patchObject(rawPatch) ?? inferSimpleFieldPatchFromMessage(message)

  const allowedItemKeys = Object.keys(row)
  const normalizedToAllowed = new Map<string, string>()
  for (const key of allowedItemKeys) normalizedToAllowed.set(key.toLowerCase(), key)

  const itemPatch: Record<string, unknown> = {}
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = key.trim()
      const fromPathPrefix = `${parsed.listKey}[${parsed.index}].`
      const childKey = normalized.startsWith(fromPathPrefix) ? normalized.slice(fromPathPrefix.length) : normalized
      const mapped = normalizedToAllowed.get(childKey.toLowerCase())
      if (mapped) itemPatch[mapped] = value
    }
  }

  if (Object.keys(itemPatch).length === 0 && isRewriteRequest(message)) {
    const preferredKey =
      (parsed.leaf && normalizedToAllowed.get(parsed.leaf.toLowerCase())) ?? inferFieldHintFromMessage(message, allowedItemKeys)
    if (preferredKey) {
      const existing = row[preferredKey]
      if (typeof existing === "string" && existing.trim().length > 0) {
        itemPatch[preferredKey] = rewriteFromExisting(existing, message)
      }
    }
  }
  if (Object.keys(itemPatch).length === 0) return null

  const nextList = list.map((entry, idx) => {
    if (idx !== parsed.index || !entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    return { ...(entry as Record<string, unknown>), ...itemPatch }
  })
  return {
    patch: { [parsed.listKey]: nextList } as Record<string, unknown>,
    changedKeys: Object.keys(itemPatch),
    rootKey: parsed.listKey
  }
}

function quotedText(message: string) {
  return /"([^"]+)"/.exec(message)?.[1]?.trim()
}

function buildListAppendPatch(block: PageDoc["blocks"][number], message: string) {
  const lower = message.toLowerCase()
  const quoted = quotedText(message)

  if (block.type === "FAQAccordion") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const q = quoted ?? (lower.includes("question") ? "New question" : "How does this work?")
    const next = [...existing, { q, a: "Add answer here." }]
    return { items: next }
  }

  if (block.type === "Testimonials") {
    const existing = Array.isArray(block.props.items) ? (block.props.items as Array<Record<string, unknown>>) : []
    const quote = quoted ?? "Great experience."
    const next = [...existing, { quote, author: "Customer" }]
    return { items: next }
  }

  if (block.type === "FeatureGrid") {
    const existing = Array.isArray(block.props.features) ? (block.props.features as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New feature"
    const next = [...existing, { title, description: "Describe this feature." }]
    return { features: next }
  }

  if (block.type === "CardGrid") {
    const existing = Array.isArray(block.props.cards) ? (block.props.cards as Array<Record<string, unknown>>) : []
    const title = quoted ?? "New card"
    const next = [...existing, { title, description: "Add card description.", ctaText: "Learn more", ctaHref: "/" }]
    return { cards: next }
  }

  return null
}

function compileDeterministicPlan(args: {
  session: string
  intent: ParsedIntent
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
}): EditPlan | null {
  const { session, intent, message, slug, currentPage, activeBlockId, activeEditablePath } = args
  const lowerMessage = message.toLowerCase()
  const routeMentions = extractRouteMentions(message)
  const assumptions: string[] = []
  if (intent.assumption) assumptions.push(intent.assumption)
  const hasConditionalQualifier = /\bif\s+(required|needed|necessary)\b/.test(lowerMessage)
  const asksSectionReorder =
    /\b(reorder|re-order|rearrange|re-organize|reorganize)\b/.test(lowerMessage) &&
    /\b(section|sections|block|blocks|content|layout|flow|readability)\b/.test(lowerMessage)
  const hasExplicitPlacementCue = /\b(top|bottom|first|last|before|after|above|below|under|between)\b/.test(lowerMessage)
  const hasExplicitBlockMentionInMessage =
    /\bb_[a-z0-9_]+\b/.test(lowerMessage) ||
    /\b(hero|feature grid|features|testimonials?|faq|cta|card grid|cards?|rich[\s-]?text)\b/.test(lowerMessage)

  const selectedBlock = activeBlockId ? currentPage.blocks.find((b) => b.id === activeBlockId) ?? null : null
  const secondaryButtonMentioned =
    lowerMessage.includes("secondary cta") ||
    lowerMessage.includes("secondary button") ||
    lowerMessage.includes("second cta") ||
    lowerMessage.includes("second button") ||
    /sec\w*nd\w*ry\s+(cta|button)/.test(lowerMessage)
  const asksSecondaryCtaAdd =
    secondaryButtonMentioned &&
    (lowerMessage.includes("add") || lowerMessage.includes("create") || lowerMessage.includes("insert") || lowerMessage.includes("include"))

  const asksPageRename = isPageRouteRenameRequest(message)
  if ((intent.action === "update" || intent.action === "move" || intent.action === "clarify") && asksPageRename) {
    const fromSlug = routeMentions[0] ?? slug
    const toSlug = routeMentions.length >= 2 ? routeMentions[routeMentions.length - 1] : undefined
    if (!toSlug || toSlug === fromSlug) {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please provide the target page path, for example: rename page from /old to /new.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Renamed page path from ${fromSlug} to ${toSlug}.`,
      change_log: [...assumptions, `Renamed page ${fromSlug} -> ${toSlug}.`],
      ops: [{ op: "rename_page", pageSlug: fromSlug, newPageSlug: toSlug }]
    }
  }

  const asksPageDelete = /\b(delete|remove)\b.*\bpage\b/.test(lowerMessage)
  if ((intent.action === "remove" || intent.action === "clarify") && asksPageDelete) {
    const targetSlug = routeMentions[0] ?? slug
    if (targetSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) cannot be deleted. Choose another page path.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Deleted page ${targetSlug}.`,
      change_log: [...assumptions, `Removed page ${targetSlug}.`],
      ops: [{ op: "remove_page", pageSlug: targetSlug }]
    }
  }

  const requestedCreateSlug = parseCreatePageRequest(message)
  if ((intent.action === "add" || intent.action === "clarify" || intent.action === "update") && requestedCreateSlug) {
    const createPlan = buildCreatePagePlan({ session, requestedSlug: requestedCreateSlug, assumptions })
    if (createPlan) return createPlan
  }

  const asksNavMove =
    /\b(nav|navigation|menu|tabs?|tab order|page order)\b/.test(lowerMessage) ||
    /\bmove\b.*\b(page|tab)\b/.test(lowerMessage) ||
    /\breorder\b.*\b(page|nav|menu|tabs?)\b/.test(lowerMessage)
  if ((intent.action === "move" || intent.action === "clarify") && asksNavMove) {
    const sessionDraft = getSessionDraft(session)
    const slugsRaw = Array.from(sessionDraft.keys())
    const ordered = slugsRaw.includes("/") ? ["/", ...slugsRaw.filter((route) => route !== "/")] : slugsRaw
    const movedSlug = routeMentions[0] ?? slug
    if (!ordered.includes(movedSlug)) {
      return {
        intent: "needs_clarification",
        summary_for_user: `I could not find page ${movedSlug}.`,
        change_log: assumptions,
        ops: []
      }
    }
    if (movedSlug === "/") {
      return {
        intent: "needs_clarification",
        summary_for_user: "Home page (/) is fixed at the first position in navigation.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterPageSlug: string | undefined
    if (/\b(top|first|start|beginning)\b/.test(lowerMessage)) {
      afterPageSlug = undefined
    } else if (/\b(bottom|last|end)\b/.test(lowerMessage)) {
      const tail = [...ordered].reverse().find((route) => route !== movedSlug)
      afterPageSlug = tail === "/" ? "/" : tail
    } else if (/\b(after|below|under)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else if (/\b(before|above)\b/.test(lowerMessage) && routeMentions.length >= 2) {
      const anchor = routeMentions[1]
      if (anchor === "/") afterPageSlug = undefined
      else {
        const index = ordered.findIndex((route) => route === anchor)
        if (index === -1) {
          return {
            intent: "needs_clarification",
            summary_for_user: `I could not find anchor page ${anchor}.`,
            change_log: assumptions,
            ops: []
          }
        }
        const previous = ordered.slice(0, index).reverse().find((route) => route !== movedSlug)
        afterPageSlug = previous === "/" ? "/" : previous
      }
    } else if (routeMentions.length >= 2) {
      afterPageSlug = routeMentions[1]
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Specify where to place the page (first/last/before/after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user:
        afterPageSlug === undefined
          ? `Moved ${movedSlug} to the first nav position (after Home).`
          : `Moved ${movedSlug} after ${afterPageSlug}.`,
      change_log: [...assumptions, `Reordered nav: ${movedSlug}`],
      ops: [{ op: "move_page", pageSlug: movedSlug, afterPageSlug }]
    }
  }

  const audience = extractAudienceTarget(message)
  const asksAudienceCreatePage =
    Boolean(audience) &&
    /\b(create|generate|build|make|draft)\b/.test(lowerMessage) &&
    /\b(page|landing page)\b/.test(lowerMessage)
  if (asksAudienceCreatePage && audience) {
    const seed = toSeedSlug(audience) || "audience"
    const requestedSlug = routeMentions[0] ?? `/for-${seed}`
    const normalizedRequested = normalizeRouteCandidate(requestedSlug) ?? `/for-${seed}`
    const newSlug = nextAvailableSlug(session, normalizedRequested)
    const label = titleCaseWords(audience)
    const now = new Date().toISOString()
    const page: PageDoc = {
      id: `p_for_${seed}`,
      slug: newSlug,
      title: `For ${label}`,
      updatedAt: now,
      blocks: [
        {
          id: `b_hero_${seed}`,
          type: "Hero",
          props: {
            heading: `Built for ${label}`,
            subheading: `Everything on this page is tailored for ${audience}.`,
            ctaText: "Get Started",
            ctaHref: "/",
            imageUrl: `https://picsum.photos/seed/${encodeURIComponent(seed)}/1600/900`,
            imageAlt: `Audience-focused hero image for ${label}`
          }
        },
        {
          id: `b_features_${seed}`,
          type: "FeatureGrid",
          props: {
            title: `Why ${label} choose this`,
            features: [
              { title: "Relevant messaging", description: `Copy aligned to ${audience} needs and language.` },
              { title: "Clear outcomes", description: "Benefits are framed around practical results." },
              { title: "Focused next step", description: "CTA is tuned for this audience journey." }
            ]
          }
        },
        {
          id: `b_faq_${seed}`,
          type: "FAQAccordion",
          props: {
            title: `FAQ for ${label}`,
            items: [
              { q: `Is this suitable for ${audience}?`, a: `Yes, this page is tailored for ${audience}.` },
              { q: "How quickly can I start?", a: "Most visitors can get started in minutes." },
              { q: "Can I customize later?", a: "Yes, content and sections can be updated anytime." }
            ]
          }
        },
        {
          id: `b_cta_${seed}`,
          type: "CTA",
          props: {
            title: `Start with a plan for ${label}`,
            description: "Take the next step with content designed for your audience.",
            ctaText: "Start now",
            ctaHref: "/"
          }
        }
      ]
    }
    return {
      intent: "edit_plan",
      summary_for_user: `Created a new page tailored for ${audience}.`,
      change_log: [...assumptions, `Created page ${newSlug} for audience: ${audience}.`],
      ops: [{ op: "create_page", page }]
    }
  }

  const asksAudienceRetarget =
    Boolean(audience) &&
    !asksAudienceCreatePage &&
    (/\bfor\b/.test(lowerMessage) || /\baudience\b/.test(lowerMessage) || /\btarget\b/.test(lowerMessage))
  if (asksAudienceRetarget && audience) {
    const targets = selectedBlock
      ? [selectedBlock]
      : currentPage.blocks.filter((block) => block.type === "Hero" || block.type === "CTA" || block.type === "RichText").slice(0, 3)
    const ops: Operation[] = []
    for (const block of targets) {
      const patch = audiencePatchForBlock(block, audience)
      if (Object.keys(patch).length === 0) continue
      ops.push({ op: "update_props", pageSlug: slug, blockId: block.id, patch })
    }
    if (ops.length > 0) {
      return {
        intent: "edit_plan",
        summary_for_user: `Tailored this page for ${audience}.`,
        change_log: [...assumptions, `Retargeted copy for audience: ${audience}.`],
        ops
      }
    }
  }

  if (intent.action === "move" && hasConditionalQualifier && asksSectionReorder && !hasExplicitPlacementCue && !hasExplicitBlockMentionInMessage) {
    return {
      intent: "needs_clarification",
      summary_for_user: "I can reorder sections if needed, but please specify what should move (for example: move FAQ below Testimonials).",
      change_log: [...assumptions, "Skipped ambiguous conditional reorder request without explicit section or placement."],
      ops: []
    }
  }

  if (
    selectedBlock?.type === "Hero" &&
    asksSecondaryCtaAdd &&
    (intent.action === "add" || intent.action === "clarify" || intent.action === "update")
  ) {
    const heroProps = selectedBlock.props as Record<string, unknown>
    const existingText = typeof heroProps.secondaryCtaText === "string" ? heroProps.secondaryCtaText.trim() : ""
    const existingHref = typeof heroProps.secondaryCtaHref === "string" ? heroProps.secondaryCtaHref.trim() : ""
    const quoted = quotedText(message)
    const patch: Record<string, unknown> = {
      secondaryCtaText: quoted ?? (existingText.length > 0 ? existingText : "Learn more"),
      secondaryCtaHref: existingHref.length > 0 ? existingHref : "/"
    }

    return {
      intent: "edit_plan",
      summary_for_user: "Added a secondary CTA button to the selected Hero.",
      change_log: [...assumptions, `Updated ${selectedBlock.id}: secondaryCtaText, secondaryCtaHref`],
      ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
    }
  }

  const asksInlineAdd =
    lowerMessage.includes("add") &&
    (lowerMessage.includes("inside") ||
      lowerMessage.includes("within") ||
      lowerMessage.includes("current") ||
      lowerMessage.includes("this one") ||
      lowerMessage.includes("more"))

  if ((intent.action === "add" || intent.action === "clarify") && selectedBlock && asksInlineAdd) {
    const patch = buildListAppendPatch(selectedBlock, message)
    if (patch) {
      return {
        intent: "edit_plan",
        summary_for_user: `Updated ${selectedBlock.type}.`,
        change_log: [...assumptions, `Added one entry to ${selectedBlock.id}.`],
        ops: [{ op: "update_props", pageSlug: slug, blockId: selectedBlock.id, patch }]
      }
    }
  }

  if (intent.action === "info" || (intent.action === "clarify" && !activeEditablePath)) {
    return {
      intent: "needs_clarification",
      summary_for_user: intent.summary ?? "Please specify the section and exact change you want.",
      change_log: assumptions,
      ops: []
    }
  }

  if (intent.action === "remove") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to remove.",
        change_log: assumptions,
        ops: []
      }
    }
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Removed ${target.type}.`,
      change_log: [...assumptions, `Removed block ${target.id}.`],
      ops: [{ op: "remove_block", pageSlug: slug, blockId: target.id }]
    }
  }

  if (intent.action === "update" || (intent.action === "clarify" && !!activeEditablePath)) {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to update.",
        change_log: assumptions,
        ops: []
      }
    }
    const childPatch = coercePatchForEditablePath(target, activeEditablePath, intent.patch, message)
    const fullPatch = coercePatchForBlock(target, intent.patch)
    const mergedRichTextTranslationPatch = shouldKeepRichTextTitleOnTranslate({
      target,
      activeEditablePath,
      message,
      fullPatch
    })
      ? { ...fullPatch, ...(childPatch?.patch ?? {}) }
      : null
    const patch = mergedRichTextTranslationPatch ?? childPatch?.patch ?? fullPatch
    if (Object.keys(patch).length === 0) {
      const editableFields = userFacingPropNames(target.type, Object.keys(target.props))
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify at least one valid field for ${target.type}.`,
        change_log: [...assumptions, `Editable fields: ${editableFields.join(", ")}`],
        ops: []
      }
    }
    const changedKeys = userFacingPropNames(target.type, Object.keys(patch))
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Updated ${target.type}.`,
      change_log: [
        ...assumptions,
        childPatch
          ? `Updated ${target.id} ${activeEditablePath}: ${changedKeys.join(", ")}`
          : `Updated ${target.id}: ${changedKeys.join(", ")}`
      ],
      ops: [{ op: "update_props", pageSlug: slug, blockId: target.id, patch }]
    }
  }

  if (intent.action === "move") {
    const target = resolveBlockRef({
      ref: intent.target_block_ref,
      currentPage,
      activeBlockId,
      fallbackType: intent.target_block_type
    })
    if (!target) {
      return {
        intent: "needs_clarification",
        summary_for_user: "I need to know which block to move.",
        change_log: assumptions,
        ops: []
      }
    }

    let afterBlockId: string | undefined
    if (intent.position === "top") {
      afterBlockId = undefined
    } else if (intent.position === "bottom") {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move after.",
          change_log: assumptions,
          ops: []
        }
      }
      afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to move before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) afterBlockId = currentPage.blocks[idx - 1]?.id
      else afterBlockId = undefined
    } else if (message.toLowerCase().includes("bottom") || message.toLowerCase().includes("end")) {
      const tail = [...currentPage.blocks].reverse().find((b) => b.id !== target.id)
      afterBlockId = tail?.id
    } else {
      return {
        intent: "needs_clarification",
        summary_for_user: "Please specify where to move the block (top, bottom, before, after).",
        change_log: assumptions,
        ops: []
      }
    }

    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Moved ${target.type}.`,
      change_log: [...assumptions, `Moved block ${target.id}.`],
      ops: [{ op: "move_block", pageSlug: slug, blockId: target.id, afterBlockId }]
    }
  }

  if (intent.action === "add") {
    const blockType =
      intent.new_block_type ??
      inferAddedBlockTypeFromMessage(message) ??
      intent.target_block_type ??
      inferBlockTypeFromText(intent.target_block_ref ?? "") ??
      inferBlockTypeFromText(message)
    if (!blockType) {
      return {
        intent: "needs_clarification",
        summary_for_user: `Please specify which block type to add (${allowedBlockTypes.join(", ")}).`,
        change_log: assumptions,
        ops: []
      }
    }

    const blockId = nextBlockId(blockType, currentPage)
    const baseProps = defaultPropsForType(blockType)
    const patch = coercePatchForBlock({ id: blockId, type: blockType, props: baseProps }, intent.patch)
    const props = { ...baseProps, ...patch }

    const addOp: Operation = {
      op: "add_block",
      pageSlug: slug,
      block: { id: blockId, type: blockType, props }
    }

    let extraMoveTop: Operation | null = null
    if (intent.position === "after" || (intent.anchor_block_ref && !intent.position)) {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this after.",
          change_log: assumptions,
          ops: []
        }
      }
      addOp.afterBlockId = anchor.id
    } else if (intent.position === "before") {
      const anchor = resolveBlockRef({ ref: intent.anchor_block_ref, currentPage })
      if (!anchor) {
        return {
          intent: "needs_clarification",
          summary_for_user: "I could not find the anchor block to place this before.",
          change_log: assumptions,
          ops: []
        }
      }
      const idx = currentPage.blocks.findIndex((b) => b.id === anchor.id)
      if (idx > 0) addOp.afterBlockId = currentPage.blocks[idx - 1]?.id
      else extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "top") {
      extraMoveTop = { op: "move_block", pageSlug: slug, blockId, afterBlockId: undefined }
    } else if (intent.position === "bottom" || !intent.position) {
      // no-op: add without anchor appends to bottom in applyOpsAtomically
    }

    const ops: Operation[] = extraMoveTop ? [addOp, extraMoveTop] : [addOp]
    return {
      intent: "edit_plan",
      summary_for_user: intent.summary ?? `Added ${blockType}.`,
      change_log: [...assumptions, `Added ${blockType} block ${blockId}.`],
      ops
    }
  }

  return null
}

async function parseIntentWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
  model: string
}): Promise<ParsedIntent> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const system = [
    "You extract editing intent for a website editor.",
    "Return ONLY one JSON object. No markdown.",
    "Never return operations.",
    "Map request to action: add | move | update | remove | info | clarify.",
    "If the user asks what is editable/available, use action=info.",
    "Use explicit block references when present (id/type words like hero/faq/cta).",
    "For move/add with placement words, set position to top/bottom/before/after and anchor_block_ref when relevant.",
    "For update, include patch with only requested fields."
  ].join("\n")

  const user = {
    request: args.message,
    slug: args.slug,
    activeBlockId: args.activeBlockId ?? null,
    activeBlockType: args.activeBlockType ?? null,
    activeEditablePath: args.activeEditablePath ?? null,
    availableBlockTypes: allowedBlockTypes,
    blocks: args.currentPage.blocks.map((b) => ({ id: b.id, type: b.type, props: Object.keys(b.props) }))
  }

  const completion = await client.chat.completions.create({
    model: args.model,
    ...openAIChatOptionsForModel(args.model),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  })

  const raw = completion.choices[0]?.message?.content ?? ""
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Intent parser did not return JSON")
  const parsedRoot = JSON.parse(jsonText) as Record<string, unknown>
  const normalized = { ...parsedRoot } as Record<string, unknown>

  if (typeof normalized.action !== "string") {
    const intent = typeof normalized.intent === "string" ? normalized.intent : undefined
    if (intent === "needs_clarification") normalized.action = "clarify"
    if (intent === "info") normalized.action = "info"
  }

  if (
    typeof normalized.action !== "string" &&
    Array.isArray(normalized.ops) &&
    normalized.ops.length > 0 &&
    normalized.ops[0] &&
    typeof normalized.ops[0] === "object"
  ) {
    const first = normalized.ops[0] as Record<string, unknown>
    const op = normalizeOpName(first.op ?? first.operation ?? first.action ?? first.kind)
    if (op === "add_block") {
      normalized.action = "add"
      const block = first.block && typeof first.block === "object" ? (first.block as Record<string, unknown>) : null
      if (block && typeof block.type === "string") normalized.new_block_type = block.type
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "bottom"
      }
      if (block && typeof block.props === "object" && block.props !== null && !Array.isArray(block.props)) {
        normalized.patch = block.props
      }
    } else if (op === "update_props") {
      normalized.action = "update"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (first.patch && typeof first.patch === "object" && !Array.isArray(first.patch)) normalized.patch = first.patch
    } else if (op === "remove_block") {
      normalized.action = "remove"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
    } else if (op === "move_block") {
      normalized.action = "move"
      if (typeof first.blockId === "string") normalized.target_block_ref = first.blockId
      if (typeof first.afterBlockId === "string") {
        normalized.position = "after"
        normalized.anchor_block_ref = first.afterBlockId
      } else {
        normalized.position = "top"
      }
    }
  }

  const parsed = intentSchema.safeParse(normalized)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const detail = issue?.message ?? "Invalid intent parser output"
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`${detail}${at}`)
  }
  return parsed.data
}

async function generatePlanWithOpenAI(args: {
  message: string
  slug: string
  currentPage: PageDoc
  contextPack: ReturnType<typeof plannerContextPack>
  model: string
  feedback?: string
  onToken?: (token: string) => void
}): Promise<EditPlan> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const selectedBlockId = String(args.contextPack.selected.blockId ?? "")
  const audienceHint = extractAudienceTarget(args.message)
  const explicitOtherReference =
    selectedBlockId.length > 0 &&
    Array.isArray(args.contextPack.resolvedReferences.mentionedBlocks) &&
    args.contextPack.resolvedReferences.mentionedBlocks.some(
      (entry) => entry && typeof entry === "object" && "id" in entry && (entry as { id?: unknown }).id !== selectedBlockId
    )

  const system = [
    "You are an editing planner for a website builder.",
    "Return ONLY one JSON object matching EditPlan.",
    "Never output markdown or code fences.",
    "If request is ambiguous, return intent=needs_clarification and no ops.",
    "When reasonably clear, make a practical assumption and proceed.",
    "Include any important assumption briefly in summary_for_user and change_log.",
    "Use only these operation names exactly: create_page, add_block, update_props, remove_block, move_block, duplicate_block, add_item, update_item, remove_item, move_item, rename_page, remove_page, move_page, duplicate_page.",
    "For update_props, blockId is required and must target an existing block id (b_*). Never use a page route/path as blockId or path.",
    "Use rename_page for page route changes (pageSlug -> newPageSlug).",
    "Use remove_page when the user asks to delete a page path.",
    "Use move_page to reorder nav pages (pageSlug + optional afterPageSlug). Home (/) must stay first.",
    "For duplicate_block, blockId is required; use optional toPageSlug when duplicating into a different page.",
    "If the user specifies an audience (e.g. 'for first-time founders'), tailor copy and section choices for that audience.",
    "If user asks to create a page for an audience, create_page with audience-specific Hero/benefits/CTA content.",
    "For update_props, set patch to changed props only; use existing prop keys for the target block type.",
    "Do not return no-op updates: patch must change at least one effective value.",
    "If contextPack.selected.editablePath is present, treat it as the primary target unless the user clearly requests a different target.",
    "For Hero imageUrl, prefer a semantically relevant Unsplash URL (or a URL explicitly provided by the user). Avoid random placeholder services for topical hero requests. Never invent local image paths.",
    ...(chatStrictPrimaryOpMode
      ? [
          "STRICT MODE: choose exactly one PRIMARY operation only.",
          "In intent=edit_plan, return exactly one op in ops[].",
          "Do not include secondary/follow-up operations."
        ]
      : []),
    selectedBlockId.length > 0 && !explicitOtherReference
      ? `Selected block is ${selectedBlockId}. You MUST target only this block in ops unless the user explicitly names a different section.`
      : "Respect explicit user target references when present.",
    `Allowed block types: ${allowedBlockTypes.join(", ")}.`
  ].join("\n")

  const user = {
    request: args.message,
    audienceHint: audienceHint ?? null,
    slug: args.slug,
    contextPack: args.contextPack,
    blockContracts: blockContractsSummary(),
    knownBlockTypes: Object.keys(blockSchemas),
    editPlanShape: {
      intent: "edit_plan | needs_clarification",
      summary_for_user: "string",
      change_log: ["string"],
      ops: ["Operation[]"]
    },
    feedback: args.feedback ?? null
  }

  let raw = ""
  if (isResponsesOnlyModel(args.model)) {
    const response = await client.responses.create({
      model: args.model,
      instructions: system,
      input: JSON.stringify(user)
    })
    raw = extractResponsesOutputText(response)
    if (args.onToken && raw.length > 0) args.onToken(raw)
  } else if (args.onToken) {
    const stream = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (typeof delta !== "string" || delta.length === 0) continue
      raw += delta
      args.onToken(delta)
    }
  } else {
    const completion = await client.chat.completions.create({
      model: args.model,
      ...openAIChatOptionsForModel(args.model),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) }
      ]
    })
    raw = completion.choices[0]?.message?.content ?? ""
  }
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error("Model did not return JSON")

  const parsed = normalizePlanCandidate(JSON.parse(jsonText), {
    defaultSlug: args.slug,
    currentPage: args.currentPage,
    userMessage: args.message
  })
  const planResult = editPlanSchema.safeParse(parsed)
  if (!planResult.success) {
    const first = planResult.error.issues[0]
    const message = first?.message ?? "Invalid model output"
    const path = first?.path?.length ? ` at ${first.path.join(".")}` : ""
    const sample = JSON.stringify(parsed).slice(0, 700)
    throw new Error(`${message}${path}. Parsed sample: ${sample}`)
  }

  if (chatStrictPrimaryOpMode && planResult.data.intent === "edit_plan" && planResult.data.ops.length > 1) {
    return {
      ...planResult.data,
      ops: [planResult.data.ops[0]]
    }
  }
  return planResult.data
}

function toErrorDetail(error: unknown) {
  if (error instanceof Error) {
    const issueMatch = /"message"\s*:\s*"([^"]+)"/.exec(error.message)
    if (issueMatch?.[1]) return issueMatch[1]
    return error.message
  }
  if (error && typeof error === "object" && "issues" in error && Array.isArray((error as { issues?: unknown[] }).issues)) {
    const first = (error as { issues: Array<{ message?: unknown; path?: unknown[] }> }).issues[0]
    if (first) {
      const msg = typeof first.message === "string" ? first.message : "Invalid model output"
      const path = Array.isArray(first.path) && first.path.length > 0 ? ` at ${first.path.join(".")}` : ""
      return `${msg}${path}`
    }
  }
  if (typeof error === "string") return error
  return "Unknown planner error"
}

type GuardrailErrorCategory = "schema_violation" | "ambiguity" | "not_found" | "no_effective_change" | "internal_error"

function classifyGuardrailError(reason: string): GuardrailErrorCategory {
  const lower = reason.toLowerCase()
  if (isNoEffectiveChangeError(reason)) return "no_effective_change"
  if (
    lower.includes("page not found") ||
    lower.includes("blockid") ||
    lower.includes("afterblockid") ||
    lower.includes("not found")
  ) {
    return "not_found"
  }
  if (lower.includes("ambiguous") || lower.includes("clarify") || lower.includes("unclear")) {
    return "ambiguity"
  }
  if (
    lower.includes("invalid") ||
    lower.includes("required") ||
    lower.includes("unknown props") ||
    lower.includes("out of range") ||
    lower.includes("must be")
  ) {
    return "schema_violation"
  }
  return "internal_error"
}

function formatValidationError(reason: string) {
  return `${classifyGuardrailError(reason)}: ${reason}`
}

function isDeterministicRepairEligible(reason: string) {
  return classifyGuardrailError(reason) === "schema_violation"
}

function buildDeterministicRepairFeedback(reason: string) {
  return `Repair strictly for schema compliance only: ${reason}. Do not change user intent or rewrite copy semantics.`
}

function applyOpsAtomically(session: string, ops: Operation[]) {
  const nextUniqueBlockId = (blocks: Array<{ id: string }>, preferred: string) => {
    const base = preferred.trim()
    if (base.length > 0 && !blocks.some((b) => b.id === base)) return base
    const root = base.length > 0 ? base : "b_block_copy"
    let i = 1
    while (blocks.some((b) => b.id === `${root}_${i}`)) i += 1
    return `${root}_${i}`
  }

  const nextDuplicateSlug = (candidateMap: Map<string, PageDoc>, sourceSlug: string) => {
    const base = sourceSlug === "/" ? "/home-copy" : `${sourceSlug.replace(/\/+$/, "")}-copy`
    if (!candidateMap.has(base)) return base
    let i = 2
    while (candidateMap.has(`${base}-${i}`)) i += 1
    return `${base}-${i}`
  }

  const rebuildOrderWithInserted = (candidateMap: Map<string, PageDoc>, insertedSlug: string, afterPageSlug?: string) => {
    const ordered = orderSlugsHomeFirst(Array.from(candidateMap.keys()))
    const withoutInserted = ordered.filter((slug) => slug !== insertedSlug)
    let insertIndex = 0
    if (afterPageSlug) {
      if (afterPageSlug === "/") insertIndex = 1
      else {
        const anchorIdx = withoutInserted.findIndex((slug) => slug === afterPageSlug)
        if (anchorIdx === -1) throw new Error(`afterPageSlug ${afterPageSlug} not found`)
        insertIndex = anchorIdx + 1
      }
    }
    withoutInserted.splice(insertIndex, 0, insertedSlug)
    return withoutInserted
  }

  const listValueForOp = (block: PageDoc["blocks"][number], listKey: string) => {
    const candidate = (block.props as Record<string, unknown>)[listKey]
    if (!Array.isArray(candidate)) throw new Error(`List ${listKey} not found on ${block.id}`)
    return candidate
  }

  const describeValidationIssue = (error: z.ZodError) => {
    const first = error.issues[0]
    const path = first?.path?.length ? first.path.join(".") : ""
    const message = first?.message ?? "Invalid value"
    return path ? `${path}: ${message}` : message
  }

  const withValidatedBlockProps = (block: PageDoc["blocks"][number], nextProps: Record<string, unknown>) => {
    const propCheck = validateBlockProps(block.type as BlockType, nextProps)
    if (!propCheck.success) throw new Error(`Invalid props for ${block.type}: ${describeValidationIssue(propCheck.error)}`)
    return propCheck.data
  }

  const sessionDraft = getSessionDraft(session)
  const staged = new Map<string, PageDoc>()
  for (const [slug, page] of sessionDraft) staged.set(slug, structuredClone(page))
  const touchedSlugs = new Set<string>()
  const deletedSlugs = new Set<string>()
  let orderChanged = false

  for (const op of ops) {
    if (op.op === "create_page") {
      staged.set(op.page.slug, structuredClone(op.page))
      touchedSlugs.add(op.page.slug)
      continue
    }

    if (op.op === "duplicate_page") {
      const source = staged.get(op.pageSlug)
      if (!source) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextSlug = normalizeRouteCandidate(op.newPageSlug) ?? nextDuplicateSlug(staged, op.pageSlug)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      op.newPageSlug = nextSlug
      const copy: PageDoc = {
        ...structuredClone(source),
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : `${source.title} Copy`,
        updatedAt: new Date().toISOString(),
        blocks: source.blocks.map((block) => ({ ...structuredClone(block), id: nextUniqueBlockId(source.blocks, `${block.id}_copy`) }))
      }
      staged.set(nextSlug, copy)
      touchedSlugs.add(nextSlug)

      const finalOrder = rebuildOrderWithInserted(staged, nextSlug, op.afterPageSlug ?? op.pageSlug)
      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (page) reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    if (op.op === "rename_page") {
      const nextSlug = normalizeRouteCandidate(op.newPageSlug)
      if (!nextSlug) throw new Error(`Invalid newPageSlug ${op.newPageSlug}`)
      if (op.pageSlug === nextSlug) throw new Error(`No effective page change for ${op.pageSlug}`)
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.has(nextSlug)) throw new Error(`Target page slug already exists: ${nextSlug}`)
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      staged.set(nextSlug, {
        ...page,
        id: pageIdFromSlug(nextSlug),
        slug: nextSlug,
        title: typeof op.newTitle === "string" && op.newTitle.trim().length > 0 ? op.newTitle.trim() : pageTitleFromSlug(nextSlug),
        updatedAt: new Date().toISOString()
      })
      touchedSlugs.add(nextSlug)

      // Keep route references consistent after a slug change.
      for (const [slug, candidate] of staged) {
        const rewritten = rewriteLinksToRenamedPage(candidate, op.pageSlug, nextSlug)
        if (!rewritten.changed) continue
        staged.set(slug, rewritten.page)
        touchedSlugs.add(slug)
      }
      continue
    }

    if (op.op === "remove_page") {
      if (op.pageSlug === "/") throw new Error("Cannot remove the home page (/)")
      const page = staged.get(op.pageSlug)
      if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)
      if (staged.size <= 1) throw new Error("Cannot remove the last remaining page")
      staged.delete(op.pageSlug)
      deletedSlugs.add(op.pageSlug)
      continue
    }

    if (op.op === "move_page") {
      if (op.pageSlug === "/") throw new Error("Home page (/) cannot be moved")
      if (!staged.has(op.pageSlug)) throw new Error(`Page not found for slug ${op.pageSlug}`)

      const ordered = orderSlugsHomeFirst(Array.from(staged.keys()))
      const movable = ordered.filter((route) => route !== "/")
      const currentIdx = movable.findIndex((route) => route === op.pageSlug)
      if (currentIdx === -1) throw new Error(`Page not found for slug ${op.pageSlug}`)
      const nextMovable = movable.filter((route) => route !== op.pageSlug)

      let insertIndex = 0
      if (op.afterPageSlug) {
        if (op.afterPageSlug === "/") insertIndex = 0
        else {
          const anchorIdx = nextMovable.findIndex((route) => route === op.afterPageSlug)
          if (anchorIdx === -1) throw new Error(`afterPageSlug ${op.afterPageSlug} not found`)
          insertIndex = anchorIdx + 1
        }
      }

      nextMovable.splice(insertIndex, 0, op.pageSlug)
      const finalOrder = ordered.includes("/") ? ["/", ...nextMovable] : nextMovable

      const reordered = new Map<string, PageDoc>()
      for (const route of finalOrder) {
        const page = staged.get(route)
        if (!page) continue
        reordered.set(route, page)
      }
      staged.clear()
      for (const [route, page] of reordered) staged.set(route, page)
      orderChanged = true
      continue
    }

    const page = staged.get(op.pageSlug)
    if (!page) throw new Error(`Page not found for slug ${op.pageSlug}`)

    if (op.op === "add_block") {
      const propCheck = validateBlockProps(op.block.type, op.block.props)
      if (!propCheck.success) throw new Error(`Invalid props for ${op.block.type}: ${describeValidationIssue(propCheck.error)}`)

      const alreadyExists = page.blocks.some((b) => b.id === op.block.id)
      if (alreadyExists) throw new Error(`Block id ${op.block.id} already exists`)

      if (!op.afterBlockId) {
        page.blocks.push({ ...op.block, props: propCheck.data })
      } else {
        const idx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (idx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(idx + 1, 0, { ...op.block, props: propCheck.data })
      }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "duplicate_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const source = page.blocks[idx]
      const targetPageSlug = typeof op.toPageSlug === "string" && op.toPageSlug.length > 0 ? op.toPageSlug : op.pageSlug
      const targetPage = staged.get(targetPageSlug)
      if (!targetPage) throw new Error(`Target page not found for slug ${targetPageSlug}`)
      const nextId = nextUniqueBlockId(targetPage.blocks, typeof op.newBlockId === "string" ? op.newBlockId : `${source.id}_copy`)
      op.newBlockId = nextId
      const duplicate = { ...structuredClone(source), id: nextId }

      if (!op.afterBlockId) {
        if (targetPageSlug === op.pageSlug) page.blocks.splice(idx + 1, 0, duplicate)
        else targetPage.blocks.push(duplicate)
      } else {
        const anchorIdx = targetPage.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (anchorIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        targetPage.blocks.splice(anchorIdx + 1, 0, duplicate)
      }
      targetPage.updatedAt = new Date().toISOString()
      touchedSlugs.add(targetPage.slug)
      continue
    }

    if (op.op === "add_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      const list = listValueForOp(block, op.listKey)
      const nextList = [...list]
      const insertIndex = typeof op.afterIndex === "number" ? op.afterIndex + 1 : nextList.length
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new Error(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`)
      }
      nextList.splice(insertIndex, 0, structuredClone(op.item))
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const currentItem = list[op.index]
      if (!currentItem || typeof currentItem !== "object" || Array.isArray(currentItem)) {
        throw new Error(`List item ${op.listKey}[${op.index}] is not an object`)
      }
      const nextList = list.map((entry, idx) => {
        if (idx !== op.index) return entry
        return { ...(entry as Record<string, unknown>), ...(op.patch as Record<string, unknown>) }
      })
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const nextList = [...list]
      nextList.splice(op.index, 1)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_item") {
      const blockIdx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (blockIdx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[blockIdx]
      const list = listValueForOp(block, op.listKey)
      if (op.index < 0 || op.index >= list.length) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const nextList = [...list]
      const [item] = nextList.splice(op.index, 1)
      if (item === undefined) throw new Error(`index ${op.index} is out of range for ${op.listKey}`)
      const insertIndex = typeof op.afterIndex === "number" ? op.afterIndex + 1 : 0
      if (insertIndex < 0 || insertIndex > nextList.length) {
        throw new Error(`afterIndex ${op.afterIndex} is out of range for ${op.listKey}`)
      }
      nextList.splice(insertIndex, 0, item)
      const nextProps = { ...(block.props as Record<string, unknown>), [op.listKey]: nextList }
      page.blocks[blockIdx] = { ...block, props: withValidatedBlockProps(block, nextProps) }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "update_props") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const block = page.blocks[idx]
      const rawPatch = op.patch as Record<string, unknown>
      const patchCandidate =
        rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
          ? (rawPatch.props as Record<string, unknown>)
          : rawPatch

      const patchKeys = Object.keys(patchCandidate ?? {})
      const schemaForType = blockSchemas[block.type as BlockType]
      const schemaShape =
        schemaForType && typeof schemaForType === "object" && "shape" in schemaForType
          ? (schemaForType.shape as Record<string, unknown>)
          : null
      const allowedPatchKeys = schemaShape ? Object.keys(schemaShape) : Object.keys(block.props as Record<string, unknown>)
      const invalidPatchKeys = patchKeys.filter((key) => !allowedPatchKeys.includes(key))
      if (invalidPatchKeys.length > 0) {
        throw new Error(
          `Patch for ${block.id} (${block.type}) used unknown props: ${invalidPatchKeys.join(", ")}. Allowed props: ${allowedPatchKeys.join(", ")}`
        )
      }

      const nextProps = { ...block.props, ...patchCandidate } as Record<string, unknown>

      const propCheck = validateBlockProps(block.type as BlockType, nextProps)
      if (!propCheck.success) throw new Error(`Invalid props for ${block.type}: ${describeValidationIssue(propCheck.error)}`)
      if (JSON.stringify(block.props) === JSON.stringify(propCheck.data)) {
        throw new Error(`No effective prop change for ${block.id}. Patch keys: ${patchKeys.join(", ") || "(none)"}`)
      }
      page.blocks[idx] = { ...block, props: propCheck.data }
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "remove_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      page.blocks.splice(idx, 1)
      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
      continue
    }

    if (op.op === "move_block") {
      const idx = page.blocks.findIndex((b) => b.id === op.blockId)
      if (idx === -1) throw new Error(`blockId ${op.blockId} not found`)
      const [block] = page.blocks.splice(idx, 1)

      if (!op.afterBlockId) {
        page.blocks.unshift(block)
      } else {
        const afterIdx = page.blocks.findIndex((b) => b.id === op.afterBlockId)
        if (afterIdx === -1) throw new Error(`afterBlockId ${op.afterBlockId} not found`)
        page.blocks.splice(afterIdx + 1, 0, block)
      }

      page.updatedAt = new Date().toISOString()
      touchedSlugs.add(page.slug)
    }
  }

  if (touchedSlugs.size === 0 && deletedSlugs.size === 0 && !orderChanged) {
    throw new Error("Edit plan produced no changes")
  }

  sessionDraft.clear()
  for (const [route, page] of staged) {
    setPage(session, page)
  }
}

function pickFocusBlockId(ops: Operation[]) {
  const add = ops.find((op) => op.op === "add_block")
  if (add && add.op === "add_block") return add.block.id

  const duplicate = ops.find((op) => op.op === "duplicate_block")
  if (duplicate && duplicate.op === "duplicate_block" && typeof duplicate.newBlockId === "string") return duplicate.newBlockId

  const listOp = ops.find(
    (op) => op.op === "add_item" || op.op === "update_item" || op.op === "remove_item" || op.op === "move_item"
  )
  if (listOp && "blockId" in listOp && typeof listOp.blockId === "string") return listOp.blockId

  const move = ops.find((op) => op.op === "move_block")
  if (move && move.op === "move_block") return move.blockId

  const update = ops.find((op) => op.op === "update_props")
  if (update && update.op === "update_props") return update.blockId

  return undefined
}

function pickUpdatedSlug(session: string, currentSlug: string, ops: Operation[]) {
  const created = ops.find((op) => op.op === "create_page")
  if (created && created.op === "create_page") return created.page.slug
  const duplicate = ops.find((op) => op.op === "duplicate_page" && op.pageSlug === currentSlug)
  if (duplicate && duplicate.op === "duplicate_page") return duplicate.newPageSlug
  const rename = ops.find((op) => op.op === "rename_page" && op.pageSlug === currentSlug)
  if (rename && rename.op === "rename_page") return rename.newPageSlug
  const current = getPage(session, currentSlug)
  if (current) return undefined
  const draft = getSessionDraft(session)
  const first = orderSlugsHomeFirst(Array.from(draft.keys()))[0]
  return first
}

function collectMentionedSlugsFromPlan(plan: EditPlan, fallbackSlug?: string) {
  const seen = new Set<string>()
  const removed = new Set<string>()
  const push = (slug?: string) => {
    if (!slug || typeof slug !== "string") return
    const normalized = normalizeRouteCandidate(slug)
    if (!normalized) return
    seen.add(normalized)
  }

  for (const op of plan.ops) {
    if (op.op === "create_page") {
      push(op.page.slug)
      continue
    }
    if (op.op === "rename_page") {
      // Old slug is not navigable after rename; only link to the new route.
      push(op.newPageSlug)
      continue
    }
    if (op.op === "remove_page") {
      const normalized = normalizeRouteCandidate(op.pageSlug)
      if (normalized) removed.add(normalized)
      continue
    }
    if (op.op === "move_page") {
      push(op.pageSlug)
      push(op.afterPageSlug)
      continue
    }
    if (op.op === "duplicate_block") {
      if (typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) push(op.toPageSlug)
      else push(op.pageSlug)
      continue
    }
    if (op.op === "duplicate_page") {
      push(op.pageSlug)
      push(op.newPageSlug)
      push(op.afterPageSlug)
      continue
    }
    push(op.pageSlug)
  }

  for (const slug of removed) seen.delete(slug)
  if (seen.size === 0) {
    const normalizedFallback = normalizeRouteCandidate(fallbackSlug)
    if (normalizedFallback && !removed.has(normalizedFallback)) seen.add(normalizedFallback)
  }
  return orderSlugsHomeFirst(Array.from(seen))
}

function collectMentionedSlugsFromOps(ops: Operation[], fallbackSlug?: string) {
  return collectMentionedSlugsFromPlan(
    {
      intent: "edit_plan",
      summary_for_user: "",
      change_log: [],
      ops
    },
    fallbackSlug
  )
}

function normalizePlanCopyForUi(plan: EditPlan, currentPage: PageDoc): EditPlan {
  const rewrite = (text: string) =>
    text
      .replace(/\bhome page secondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bsecondary cta\b/gi, "Hero secondary CTA")
      .replace(/\bhero block imageurl\b/gi, "Hero block image")
      .replace(/\bimageurl\b/gi, "Hero block image")
      .replace(/\bimagealt\b/gi, "Hero image alt text")

  const normalizedSummary = rewrite(plan.summary_for_user)
  const normalizedChangeLog = plan.change_log.map(rewrite)

  if (plan.intent !== "edit_plan" || plan.ops.length !== 1) return plan
  const [op] = plan.ops
  if (op.op !== "update_props") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const block = currentPage.blocks.find((entry) => entry.id === op.blockId)
  if (!block || block.type !== "Hero") {
    if (normalizedSummary !== plan.summary_for_user || normalizedChangeLog.some((line, idx) => line !== plan.change_log[idx])) {
      return { ...plan, summary_for_user: normalizedSummary, change_log: normalizedChangeLog }
    }
    return plan
  }
  const patch = op.patch as Record<string, unknown>
  const hasSecondaryText = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaText")
  const hasSecondaryHref = Object.prototype.hasOwnProperty.call(patch, "secondaryCtaHref")
  if (!hasSecondaryText && !hasSecondaryHref) return plan

  const nextSummary = "Renamed the Hero secondary CTA."
  const nextChangeLog = ["Updated the Hero secondary CTA text/link."]
  return {
    ...plan,
    summary_for_user: nextSummary,
    change_log: nextChangeLog
  }
}

async function withUnsplashHeroImage(args: {
  plan: EditPlan
  message: string
  slug: string
  currentPage: PageDoc
  activeBlockId?: string
  activeEditablePath?: string
  chatRequestId?: string
}): Promise<EditPlan> {
  const lowerMessage = args.message.toLowerCase()
  if (args.plan.intent !== "edit_plan") return args.plan

  const explicitUnsplashRequest = lowerMessage.includes("unsplash")
  app.log.info(
    {
      event: "hero_image_rewrite_start",
      chatRequestId: args.chatRequestId,
      slug: args.slug,
      explicitUnsplashRequest,
      message: args.message
    },
    "Evaluating hero image rewrite"
  )

  const plan = structuredClone(args.plan)
  let changed = false
  let sourceQuery: string | undefined

  for (const op of plan.ops) {
    if (op.op !== "update_props" || op.pageSlug !== args.slug) continue
    const target = args.currentPage.blocks.find((block) => block.id === op.blockId)
    if (!target || target.type !== "Hero") continue

    const rawPatch = op.patch as Record<string, unknown>
    const patchCandidate =
      rawPatch && typeof rawPatch.props === "object" && rawPatch.props !== null && !Array.isArray(rawPatch.props)
        ? (rawPatch.props as Record<string, unknown>)
        : rawPatch

    const requestedImageUrl = typeof patchCandidate.imageUrl === "string" ? patchCandidate.imageUrl.trim() : ""
    const touchesImage =
      Object.prototype.hasOwnProperty.call(patchCandidate, "imageUrl") ||
      args.activeEditablePath === "imageUrl" ||
      /\b(image|photo|picture)\b/.test(lowerMessage)
    const userProvidedExplicitUrl = Boolean(firstUrlFromText(args.message))
    const shouldReplaceWithUnsplash =
      !userProvidedExplicitUrl && touchesImage && (explicitUnsplashRequest || requestedImageUrl.length > 0)
    if (!touchesImage || !shouldReplaceWithUnsplash) continue

    const query = heroImageQueryFromContext({
      message: args.message,
      currentPage: args.currentPage,
      targetBlock: target,
      patchCandidate
    })
    let resolved: UnsplashImage | null = null
    if (!explicitUnsplashRequest && process.env.OPENAI_API_KEY) {
      const generatedAlt = `AI-generated hero image featuring ${query}`
      const generatedPrompt = [
        "Use case: website hero image update",
        `Primary subject: ${query}`,
        "Style: photorealistic editorial product photography",
        "Composition: clean landscape frame with clear focal subject",
        "Lighting: natural and vibrant",
        "Constraints: no text, no logos, no watermark"
      ].join("\n")
      resolved = await generateVariationImageWithOpenAI({ prompt: generatedPrompt, altText: generatedAlt })
    }
    if (!resolved) {
      resolved = await resolveUnsplashImage(query, { subjectKeywords: imageKeywordsFromQuery(query, 4) }, { chatRequestId: args.chatRequestId })
    }
    if (!resolved) continue

    const nextPatch: Record<string, unknown> = { ...patchCandidate, imageUrl: resolved.url }
    if (
      !Object.prototype.hasOwnProperty.call(nextPatch, "imageAlt") ||
      typeof nextPatch.imageAlt !== "string" ||
      nextPatch.imageAlt.trim().length === 0
    ) {
      nextPatch.imageAlt = resolved.alt
    }
    op.patch = nextPatch
    sourceQuery = resolved.query
    app.log.info(
      {
        event: "hero_image_rewrite_applied",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        blockId: op.blockId,
        query,
        explicitUnsplashRequest,
        previousImageUrl: requestedImageUrl,
        nextImageUrl: resolved.url,
        nextImageAlt: nextPatch.imageAlt
      },
      "Applied hero image rewrite"
    )
    changed = true
  }

  if (!changed && explicitUnsplashRequest && /\b(image|photo|picture|hero)\b/.test(lowerMessage)) {
    const selectedBlock =
      args.activeBlockId && args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        ? args.currentPage.blocks.find((block) => block.id === args.activeBlockId)
        : null
    const fallbackHero =
      selectedBlock?.type === "Hero" ? selectedBlock : args.currentPage.blocks.find((block) => block.type === "Hero") ?? null

    if (fallbackHero) {
      const query = heroImageQueryFromContext({
        message: args.message,
        currentPage: args.currentPage,
        targetBlock: fallbackHero
      })
      const resolved = await resolveUnsplashImage(
        query,
        { subjectKeywords: imageKeywordsFromQuery(query, 4) },
        { chatRequestId: args.chatRequestId }
      )
      if (!resolved) return plan

      plan.ops.push({
        op: "update_props",
        pageSlug: args.slug,
        blockId: fallbackHero.id,
        patch: { imageUrl: resolved.url, imageAlt: resolved.alt }
      })
      sourceQuery = resolved.query
      changed = true
    }
  }

  if (changed) {
    const loggedQuery = sourceQuery ? ` from query "${sourceQuery}"` : ""
    plan.change_log = [...plan.change_log, `Set Hero image to a relevant result${loggedQuery}.`]
  } else {
    app.log.info(
      {
        event: "hero_image_rewrite_skipped",
        chatRequestId: args.chatRequestId,
        slug: args.slug,
        explicitUnsplashRequest,
        message: args.message
      },
      "Skipped hero image rewrite"
    )
  }

  return plan
}

function resolveEffectiveSlug(args: { session: string; requestedSlug: string; activeBlockId?: string }) {
  const { session, requestedSlug, activeBlockId } = args
  if (!activeBlockId) return requestedSlug
  const current = getPage(session, requestedSlug)
  if (current?.blocks.some((block) => block.id === activeBlockId)) return requestedSlug
  const draft = getSessionDraft(session)
  for (const [slug, page] of draft) {
    if (page.blocks.some((block) => block.id === activeBlockId)) return slug
  }
  return requestedSlug
}

function isNoEffectiveChangeError(reason: string) {
  return /No effective prop change/i.test(reason)
}

const AI_JUSTIFICATION_PREFIX = "__ai_justification__:"
const AI_PERFORMANCE_PREFIX = "__ai_performance__:"

function isRewriteLikeMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\brewrite\b/.test(lower) ||
    /\brephrase\b/.test(lower) ||
    /\breword\b/.test(lower) ||
    /\bmake\b.*\b(shorter|clearer|crisper|concise)\b/.test(lower) ||
    /\bimprove\b.*\b(copy|text|wording|messaging)\b/.test(lower) ||
    /\bchange\b.*\b(tone|copy|wording)\b/.test(lower)
  )
}

function isPerformanceAwareMessage(message: string) {
  const lower = message.toLowerCase()
  return (
    /\bseo\b/.test(lower) ||
    /\bkeyword/.test(lower) ||
    /\bsemantic/.test(lower) ||
    /\bconversion/.test(lower) ||
    /\baccessibility/.test(lower) ||
    /\breadability/.test(lower) ||
    /\bcta\b/.test(lower) ||
    /\bperformance\b/.test(lower)
  )
}

function isLikelyTextField(key: string) {
  if (!key) return false
  return !/(^|\.)(?:href|url|image|icon|id)$/i.test(key)
}

function collectChangedTextFields(ops: Operation[]) {
  const out = new Set<string>()
  for (const op of ops) {
    if (op.op === "update_props") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(key)
      }
      continue
    }

    if (op.op === "update_item") {
      const patch = op.patch as Record<string, unknown>
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (typeof value !== "string" || value.trim().length === 0) continue
        if (!isLikelyTextField(key)) continue
        out.add(`${op.listKey}.${key}`)
      }
    }
  }
  return Array.from(out)
}

function buildAiInsightChanges(args: { plan: EditPlan; message: string }) {
  if (args.plan.intent !== "edit_plan" || args.plan.ops.length === 0) return []

  const textFields = collectChangedTextFields(args.plan.ops)
  if (textFields.length === 0) return []

  const rewriteLike = isRewriteLikeMessage(args.message)
  const performanceAware = isPerformanceAwareMessage(args.message)

  const lines: string[] = []
  if (rewriteLike) {
    lines.push(`${AI_JUSTIFICATION_PREFIX}This version is more benefit-driven and action-oriented.`)
  }
  if (performanceAware) {
    lines.push(`${AI_PERFORMANCE_PREFIX}This wording improves semantic relevance and supports SEO, accessibility, and conversion checks.`)
  }
  return lines
}

function deterministicCreatePagePlan(args: { session: string; message: string }) {
  const requestedSlug = parseCreatePageRequest(args.message)
  if (!requestedSlug) return null
  return buildCreatePagePlan({ session: args.session, requestedSlug })
}

async function runChatPipeline(
  body: ChatRequestBody,
  options?: {
    onPlanningToken?: (token: string) => void
    onOpApplied?: (event: { index: number; total: number; op: Operation; previewVersion: number; focusBlockId?: string }) => void
  }
): Promise<{ code: number; payload: ChatResult | { error: string } }> {
  if (!body.session || !body.slug || !body.message) {
    return { code: 400, payload: { error: "session, slug, and message are required" } }
  }
  const messageWithContext = withSiteContext(body.message, body.sitePurpose, body.siteHosting)
  const plannerMessage = plannerMessageWithPendingContext(body.session, messageWithContext)
  const chatRequestId = randomUUID()
  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: body.activeBlockId
  })
  app.log.info(
    {
      event: "chat_pipeline_start",
      chatRequestId,
      session: body.session,
      requestedSlug,
      effectiveSlug,
      activeBlockId: body.activeBlockId,
      activeEditablePath: body.activeEditablePath,
      message: body.message
    },
    "Chat pipeline request received"
  )

  const modelKey = body.modelKey && modelLookup[body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = modelLookup[modelKey]
  const plannerSource: "openai" | "demo" = process.env.OPENAI_API_KEY ? "openai" : "demo"
  const promptHash = telemetryPromptHash(plannerMessage)
  const promptExcerpt = telemetryPromptExcerpt(plannerMessage)
  const withDebugPayload = (
    payload: ChatResult,
    extra?: Partial<NonNullable<ChatResult["debug"]>>
  ): ChatResult => ({
    ...payload,
    debug: {
      traceId: chatRequestId,
      promptHash,
      promptExcerpt,
      ...(payload.debug ?? {}),
      ...(extra ?? {})
    }
  })
  pushChatTelemetry({
    id: chatRequestId,
    at: new Date().toISOString(),
    phase: "received",
    session: body.session,
    requestedSlug,
    effectiveSlug,
    plannerSource,
    modelKey,
    modelUsed,
    promptHash,
    promptExcerpt,
    promptLength: plannerMessage.length
  })

  const current = getPage(body.session, effectiveSlug)
  if (!current) return { code: 404, payload: { error: "page not found" } }

  if (isInfoQuery(body.message)) {
    const info = infoResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: info.code, payload: withDebugPayload(info.payload, { outcome: "info" }) }
  }
  if (isAdviceQuery(body.message)) {
    pendingClarificationBySession.delete(body.session)
    const advice = adviceResponse({ body, current, plannerSource, modelUsed, modelKey })
    return { code: advice.code, payload: withDebugPayload(advice.payload, { outcome: "advice" }) }
  }

  const contextPack = plannerContextPack({
    session: body.session,
    slug: effectiveSlug,
    message: plannerMessage,
    currentPage: current,
    activeBlockId: body.activeBlockId,
    activeBlockType: body.activeBlockType,
    activeEditablePath: body.activeEditablePath
  })

  const guardrailFailureResponse = (args: { reason: string; source: "openai" | "demo" }) => {
    const category = classifyGuardrailError(args.reason)
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: args.source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "guardrail_failure",
      reason: args.reason.slice(0, 300),
      reasonCategory: category
    })
    if (category === "ambiguity") {
      const selected =
        body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
          ? current.blocks.find((b) => b.id === body.activeBlockId)
          : null
      return {
        code: 200,
        payload: withDebugPayload({
          status: "needs_clarification",
          summary: "I need one more detail before applying this safely.",
          changes: [],
          mentionedSlugs: [effectiveSlug],
          suggestions: clarificationSuggestions({ body, current, selected }),
          previewVersion: versions.get(body.session!) ?? 0,
          plannerSource: args.source,
          modelUsed,
          modelKey
        } satisfies ChatResult, { outcome: "needs_clarification", reasonCategory: category })
      }
    }
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(args.reason)],
        previewVersion: versions.get(body.session!) ?? 0,
        plannerSource: args.source,
        modelUsed,
        modelKey
      } satisfies ChatResult, { outcome: "validation_error", reasonCategory: category })
    }
  }

  const respondFromPlan = async (plan: EditPlan, source: "openai" | "demo") => {
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "plan_generated",
      session: body.session!,
      requestedSlug,
      effectiveSlug,
      plannerSource: source,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      intent: plan.intent,
      opCount: plan.ops.length,
      opTypes: plan.ops.map((op) => op.op)
    })
    let resolvedPlan = normalizePlanCopyForUi(plan, current)
    resolvedPlan = await withUnsplashHeroImage({
      plan: resolvedPlan,
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      activeBlockId: body.activeBlockId,
      activeEditablePath: body.activeEditablePath,
      chatRequestId
    })

    if (resolvedPlan.intent === "needs_clarification" && body.activeBlockId) {
      const focusedFallback = compileDeterministicPlan({
        session: body.session ?? "dev",
        intent: { action: "clarify" },
        message: plannerMessage,
        slug: effectiveSlug ?? "/",
        currentPage: current,
        activeBlockId: body.activeBlockId,
        activeEditablePath: body.activeEditablePath
      })
      if (focusedFallback?.intent === "edit_plan" && focusedFallback.ops.length > 0) {
        resolvedPlan = focusedFallback
      }
    }

    if (resolvedPlan.intent === "needs_clarification" && isBlockCatalogQuery(body.message!)) {
      const forcedInfo = infoResponse({ body, current, plannerSource: source, modelUsed, modelKey })
      return { done: true as const, response: forcedInfo }
    }

    if (resolvedPlan.intent === "needs_clarification") {
      pendingClarificationBySession.set(body.session!, { baseRequest: plannerMessage, updatedAt: new Date().toISOString() })
      pushChatTelemetry({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "needs_clarification",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op)
      })
      const selected =
        body.activeBlockId && current.blocks.find((b) => b.id === body.activeBlockId)
          ? current.blocks.find((b) => b.id === body.activeBlockId)
          : null
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "needs_clarification",
            summary: resolvedPlan.summary_for_user,
            changes: resolvedPlan.change_log,
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, effectiveSlug),
            suggestions: clarificationSuggestions({ body, current, selected }),
            previewVersion: versions.get(body.session!) ?? 0,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "needs_clarification",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op)
          })
        }
      }
    }

    const previous = getPage(body.session!, effectiveSlug)
    if (!previous) {
      return {
        done: true as const,
        response: { code: 404, payload: { error: "page not found" } as { error: string } }
      }
    }

    try {
      const hasPageStructuralOps = resolvedPlan.ops.some(
        (op) => op.op === "create_page" || op.op === "rename_page" || op.op === "remove_page" || op.op === "move_page" || op.op === "duplicate_page"
      )
      if (options?.onOpApplied && !hasPageStructuralOps) {
        const rollbackBySlug = new Map<string, PageDoc>()
        for (const op of resolvedPlan.ops) {
          const slugsToSnapshot: string[] = []
          if (op.op === "create_page") slugsToSnapshot.push(op.page.slug)
          else slugsToSnapshot.push(op.pageSlug)
          if (op.op === "duplicate_block" && typeof op.toPageSlug === "string" && op.toPageSlug.length > 0) {
            slugsToSnapshot.push(op.toPageSlug)
          }

          for (const slug of slugsToSnapshot) {
            if (rollbackBySlug.has(slug)) continue
            const existing = getPage(body.session!, slug)
            if (existing) rollbackBySlug.set(slug, structuredClone(existing))
          }
        }

        // Validate the whole plan from the current state before progressive apply.
        applyOpsAtomically(body.session!, resolvedPlan.ops)

        // Roll back to pre-apply state so we can replay ops progressively.
        for (const [slug, snapshot] of rollbackBySlug) {
          setPage(body.session!, { ...snapshot, slug })
        }
        for (const op of resolvedPlan.ops) {
          if (op.op === "create_page") {
            if (rollbackBySlug.has(op.page.slug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.page.slug)!))
              continue
            }
            const sessionDraft = getSessionDraft(body.session!)
            sessionDraft.delete(op.page.slug)
            continue
          }
          if (op.op === "rename_page") {
            const sessionDraft = getSessionDraft(body.session!)
            if (rollbackBySlug.has(op.newPageSlug)) {
              setPage(body.session!, structuredClone(rollbackBySlug.get(op.newPageSlug)!))
            } else {
              sessionDraft.delete(op.newPageSlug)
            }
          }
        }

        const total = resolvedPlan.ops.length
        for (let index = 0; index < total; index += 1) {
          const op = resolvedPlan.ops[index]
          applyOpsAtomically(body.session!, [op])
          const previewVersion = bumpVersion(body.session!)
          options.onOpApplied({
            index: index + 1,
            total,
            op,
            previewVersion,
            focusBlockId: pickFocusBlockId([op])
          })
        }
      } else {
        applyOpsAtomically(body.session!, resolvedPlan.ops)
      }
      pushUndo(body.session!, effectiveSlug, previous)
      pendingClarificationBySession.delete(body.session!)
      const planUpdatedSlug = pickUpdatedSlug(body.session!, effectiveSlug, resolvedPlan.ops)
      const updatedSlug = planUpdatedSlug ?? (effectiveSlug !== requestedSlug ? effectiveSlug : undefined)
      pushRecentEdit(body.session!, { slug: updatedSlug ?? effectiveSlug, summary: resolvedPlan.summary_for_user, ops: resolvedPlan.ops })
      const previewVersion = options?.onOpApplied ? (versions.get(body.session!) ?? 0) : bumpVersion(body.session!)
      schedulePersistState()
      const focusBlockId = pickFocusBlockId(resolvedPlan.ops)
      const aiInsightChanges = buildAiInsightChanges({ plan: resolvedPlan, message: plannerMessage })
      pushChatTelemetry({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "applied",
        intent: resolvedPlan.intent,
        opCount: resolvedPlan.ops.length,
        opTypes: resolvedPlan.ops.map((op) => op.op)
      })
      return {
        done: true as const,
        response: {
          code: 200,
          payload: withDebugPayload({
            status: "applied",
            summary: resolvedPlan.summary_for_user,
            changes: [...resolvedPlan.change_log, ...aiInsightChanges],
            mentionedSlugs: collectMentionedSlugsFromPlan(resolvedPlan, updatedSlug ?? effectiveSlug),
            previewVersion,
            focusBlockId,
            updatedSlug,
            plannerSource: source,
            modelUsed,
            modelKey
          } satisfies ChatResult, {
            outcome: "applied",
            intent: resolvedPlan.intent,
            opCount: resolvedPlan.ops.length,
            opTypes: resolvedPlan.ops.map((op) => op.op)
          })
        }
      }
    } catch (error) {
      const reason = toErrorDetail(error)
      if (isNoEffectiveChangeError(reason)) {
        pushChatTelemetry({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session!,
          requestedSlug,
          effectiveSlug,
          plannerSource: source,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "no_effective_change",
          reason: reason.slice(0, 300)
        })
        return {
          done: true as const,
          response: {
            code: 200,
            payload: withDebugPayload({
              status: "applied",
              summary: "No changes needed. That content is already up to date.",
              changes: [],
              mentionedSlugs: [effectiveSlug],
              previewVersion: versions.get(body.session!) ?? 0,
              plannerSource: source,
              modelUsed,
              modelKey
            } satisfies ChatResult, { outcome: "no_effective_change" })
          }
        }
      }
      pushChatTelemetry({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_apply_failed",
        session: body.session!,
        requestedSlug,
        effectiveSlug,
        plannerSource: source,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "apply_failed",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason)
      })
      return { done: false as const, reason }
    }
  }

  const forcedCreatePlan = deterministicCreatePagePlan({ session: body.session, message: plannerMessage })
  if (forcedCreatePlan) {
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "forced_plan",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "forced_create_page",
      intent: forcedCreatePlan.intent,
      opCount: forcedCreatePlan.ops.length,
      opTypes: forcedCreatePlan.ops.map((op) => op.op)
    })
    const forcedOutcome = await respondFromPlan(forcedCreatePlan, plannerSource)
    if (forcedOutcome.done) return forcedOutcome.response
  }

  if (!process.env.OPENAI_API_KEY) {
    try {
      const demoPlan = demoPlanFromMessage(plannerMessage, effectiveSlug, body.activeBlockId, body.activeBlockType)
      const outcome = await respondFromPlan(demoPlan, "demo")
      if (outcome.done) return outcome.response
      return guardrailFailureResponse({ reason: outcome.reason, source: "demo" })
    } catch (error) {
      const reason = toErrorDetail(error)
      pushChatTelemetry({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "result",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource: "demo",
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: "planner_exception",
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason)
      })
      return {
        code: 500,
        payload: withDebugPayload({
          status: "error",
          summary: "Could not generate an edit plan.",
          changes: [reason.slice(0, 300)],
          previewVersion: versions.get(body.session) ?? 0,
          plannerSource: "demo",
          modelUsed,
          modelKey
        }, { outcome: "planner_exception", reasonCategory: classifyGuardrailError(reason) })
      }
    }
  }

  const maxPlanningAttempts = 3
  let initialPlan: EditPlan | null = null
  const planningErrors: string[] = []

  for (let attempt = 1; attempt <= maxPlanningAttempts; attempt += 1) {
    try {
      initialPlan = await generatePlanWithOpenAI({
        message: plannerMessage,
        slug: effectiveSlug,
        currentPage: current,
        contextPack,
        model: modelUsed,
        onToken: options?.onPlanningToken
      })
      break
    } catch (error) {
      const reason = toErrorDetail(error)
      pushChatTelemetry({
        id: chatRequestId,
        at: new Date().toISOString(),
        phase: "plan_attempt_failed",
        session: body.session,
        requestedSlug,
        effectiveSlug,
        plannerSource,
        modelKey,
        modelUsed,
        promptHash,
        promptExcerpt,
        promptLength: plannerMessage.length,
        outcome: `attempt_${attempt}_failed`,
        reason: reason.slice(0, 300),
        reasonCategory: classifyGuardrailError(reason)
      })
      planningErrors.push(`Attempt ${attempt} planning failed: ${reason}`)
      if (attempt === maxPlanningAttempts) {
        pushChatTelemetry({
          id: chatRequestId,
          at: new Date().toISOString(),
          phase: "result",
          session: body.session,
          requestedSlug,
          effectiveSlug,
          plannerSource,
          modelKey,
          modelUsed,
          promptHash,
          promptExcerpt,
          promptLength: plannerMessage.length,
          outcome: "planning_exhausted",
          reason: reason.slice(0, 300),
          reasonCategory: classifyGuardrailError(reason)
        })
        return {
          code: 500,
          payload: withDebugPayload({
            status: "error",
            summary: "Could not generate an edit plan.",
            changes: [reason.slice(0, 300)],
            validationErrors: planningErrors.slice(-3),
            previewVersion: versions.get(body.session) ?? 0,
            plannerSource,
            modelUsed,
            modelKey
          }, { outcome: "planning_exhausted", reasonCategory: classifyGuardrailError(reason) })
        }
      }
    }
  }

  if (!initialPlan) {
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "planning_missing"
    })
    return {
      code: 500,
      payload: withDebugPayload({
        status: "error",
        summary: "Could not generate an edit plan.",
        changes: [],
        validationErrors: planningErrors.slice(-3),
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "planning_missing" })
    }
  }

  const initialOutcome = await respondFromPlan(initialPlan, "openai")
  if (initialOutcome.done) return initialOutcome.response

  if (!isDeterministicRepairEligible(initialOutcome.reason)) {
    return guardrailFailureResponse({ reason: initialOutcome.reason, source: "openai" })
  }

  let repairedPlan: EditPlan
  try {
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_attempt",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_started",
      reason: initialOutcome.reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(initialOutcome.reason)
    })
    repairedPlan = await generatePlanWithOpenAI({
      message: plannerMessage,
      slug: effectiveSlug,
      currentPage: current,
      contextPack,
      model: modelUsed,
      feedback: buildDeterministicRepairFeedback(initialOutcome.reason),
      onToken: options?.onPlanningToken
    })
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "repair_generated",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_plan_generated",
      intent: repairedPlan.intent,
      opCount: repairedPlan.ops.length,
      opTypes: repairedPlan.ops.map((op) => op.op)
    })
  } catch (error) {
    const reason = toErrorDetail(error)
    pushChatTelemetry({
      id: chatRequestId,
      at: new Date().toISOString(),
      phase: "result",
      session: body.session,
      requestedSlug,
      effectiveSlug,
      plannerSource,
      modelKey,
      modelUsed,
      promptHash,
      promptExcerpt,
      promptLength: plannerMessage.length,
      outcome: "repair_failed",
      reason: reason.slice(0, 300),
      reasonCategory: classifyGuardrailError(reason)
    })
    return {
      code: 400,
      payload: withDebugPayload({
        status: "validation_error",
        summary: "I could not apply that change safely.",
        changes: [],
        validationErrors: [formatValidationError(reason)],
        previewVersion: versions.get(body.session) ?? 0,
        plannerSource,
        modelUsed,
        modelKey
      }, { outcome: "repair_failed", reasonCategory: classifyGuardrailError(reason) })
    }
  }

  const repairedOutcome = await respondFromPlan(repairedPlan, "openai")
  if (repairedOutcome.done) return repairedOutcome.response
  return guardrailFailureResponse({ reason: repairedOutcome.reason, source: "openai" })
}

async function runVariationPipeline(body: VariationRequestBody): Promise<{ code: number; payload: VariationResult | { error: string } }> {
  if (!body.session || !body.slug || !body.message) {
    return { code: 400, payload: { error: "session, slug, and message are required" } }
  }
  const contextualMessage = withSiteContext(body.message, body.sitePurpose, body.siteHosting)

  const requestedSlug = body.slug
  const effectiveSlug = resolveEffectiveSlug({
    session: body.session,
    requestedSlug,
    activeBlockId: body.activeBlockId
  })
  if (!body.activeBlockId) {
    return { code: 400, payload: { error: "Select a block first before generating variations." } }
  }

  const page = getPage(body.session, effectiveSlug)
  if (!page) return { code: 404, payload: { error: "page not found" } }
  const selected = page.blocks.find((block) => block.id === body.activeBlockId)
  if (!selected) {
    return { code: 404, payload: { error: "selected block not found on current page" } }
  }

  const modelKey = body.modelKey && modelLookup[body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = modelLookup[modelKey]
  const count = requestedVariationCount(contextualMessage)
  const plannerSource: "openai" | "demo" = process.env.OPENAI_API_KEY ? "openai" : "demo"

  let variations: VariationOption[] = []
  if (process.env.OPENAI_API_KEY) {
    try {
      variations = await generateVariationsWithOpenAI({
        block: selected,
        message: contextualMessage,
        model: modelUsed,
        modelKey,
        count
      })
    } catch {
      variations = []
    }
  }

  if (variations.length < count) {
    const fallback = deterministicVariations({
      block: selected,
      message: contextualMessage,
      count,
      existing: variations
    })
    variations = [...variations, ...fallback].slice(0, count)
  }

  variations = await withDefaultImageVariations({
    block: selected,
    message: contextualMessage,
    variations
  })

  if (variations.length === 0) {
    return {
      code: 400,
      payload: { error: "Could not generate valid variations for this block. Try a more specific instruction." }
    }
  }

  return {
    code: 200,
    payload: {
      status: "ok",
      summary: `Generated ${variations.length} variations for ${selected.type}.`,
      blockId: selected.id,
      blockType: selected.type,
      pageSlug: effectiveSlug,
      baseProps: structuredClone(selected.props as Record<string, unknown>),
      variations,
      plannerSource,
      modelUsed,
      modelKey
    }
  }
}

function sseWrite(reply: { raw: NodeJS.WritableStream }, payload: unknown) {
  const stream = reply.raw as NodeJS.WritableStream & {
    destroyed?: boolean
    writableEnded?: boolean
    writable?: boolean
  }
  if (stream.destroyed || stream.writableEnded === true || stream.writable === false) return
  try {
    stream.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // Client disconnected; ignore write errors for SSE.
  }
}

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
    schedulePersistState()
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
  const result = await runChatPipeline({ ...body, session: scopedSessionKey(body.session, body.siteId) })
  return reply.code(result.code).send(result.payload)
})

app.post("/chat/variations", async (request, reply) => {
  const body = request.body as VariationRequestBody
  const result = await runVariationPipeline({ ...body, session: scopedSessionKey(body.session, body.siteId) })
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
  const result = await runChatPipeline(scopedQuery, {
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
  schedulePersistState()
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
  schedulePersistState()
  return { status: "applied", previewVersion }
})

app.get("/health", async () => ({ ok: true }))
app.get("/status/planner", async () => ({
  plannerSource: process.env.OPENAI_API_KEY ? "openai" : "demo",
  unsplashConfigured: Boolean(process.env.UNSPLASH_ACCESS_KEY?.trim())
}))
app.get("/telemetry/chat", async (request) => {
  const query = request.query as { limit?: string; outcome?: string; phase?: string; session?: string }
  const limitRaw = Number(query.limit ?? 100)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 1000) : 100
  let rows = chatTelemetryBuffer
  if (query.outcome) rows = rows.filter((row) => row.outcome === query.outcome)
  if (query.phase) rows = rows.filter((row) => row.phase === query.phase)
  if (query.session) rows = rows.filter((row) => row.session === query.session)

  const recent = rows.slice(Math.max(0, rows.length - limit))
  const byOutcome: Record<string, number> = {}
  const byReasonCategory: Record<string, number> = {}
  for (const row of recent) {
    if (row.outcome) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1
    if (row.reasonCategory) byReasonCategory[row.reasonCategory] = (byReasonCategory[row.reasonCategory] ?? 0) + 1
  }

  return {
    totalBuffered: chatTelemetryBuffer.length,
    returned: recent.length,
    byOutcome,
    byReasonCategory,
    rows: recent
  }
})
app.get("/telemetry/chat/review", async (request) => {
  const query = request.query as { limit?: string; session?: string }
  const limitRaw = Number(query.limit ?? 300)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 2000) : 300
  let rows = chatTelemetryBuffer
  if (query.session) rows = rows.filter((row) => row.session === query.session)
  const recent = rows.slice(Math.max(0, rows.length - limit))

  const failureOutcomes = new Set([
    "guardrail_failure",
    "apply_failed",
    "repair_failed",
    "planner_exception",
    "planning_exhausted",
    "planning_missing"
  ])
  const failures = recent.filter((row) => row.phase === "result" && row.outcome && failureOutcomes.has(row.outcome))
  const success = recent.filter((row) => row.phase === "result" && row.outcome === "applied")

  const failureByReasonCategory: Record<string, number> = {}
  const failureByOutcome: Record<string, number> = {}
  const byPromptHash = new Map<
    string,
    { promptExcerpt: string; count: number; outcomes: Record<string, number>; reasonCategories: Record<string, number>; lastAt: string }
  >()

  for (const row of failures) {
    if (row.reasonCategory) failureByReasonCategory[row.reasonCategory] = (failureByReasonCategory[row.reasonCategory] ?? 0) + 1
    if (row.outcome) failureByOutcome[row.outcome] = (failureByOutcome[row.outcome] ?? 0) + 1
    const current =
      byPromptHash.get(row.promptHash) ??
      { promptExcerpt: row.promptExcerpt, count: 0, outcomes: {}, reasonCategories: {}, lastAt: row.at }
    current.count += 1
    if (row.outcome) current.outcomes[row.outcome] = (current.outcomes[row.outcome] ?? 0) + 1
    if (row.reasonCategory) current.reasonCategories[row.reasonCategory] = (current.reasonCategories[row.reasonCategory] ?? 0) + 1
    if (row.at > current.lastAt) current.lastAt = row.at
    byPromptHash.set(row.promptHash, current)
  }

  const topFailedPrompts = Array.from(byPromptHash.entries())
    .map(([promptHash, value]) => ({ promptHash, ...value }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)

  const recommendations: string[] = []
  if ((failureByReasonCategory.schema_violation ?? 0) > 0) {
    recommendations.push("Schema violations are frequent: add stricter pre-apply normalization for missing required fields and alias keys.")
  }
  if ((failureByReasonCategory.not_found ?? 0) > 0) {
    recommendations.push("Not-found failures detected: improve slug/block resolution using active selection and current page context.")
  }
  if ((failureByReasonCategory.ambiguity ?? 0) > 0) {
    recommendations.push("Ambiguity is high: improve follow-up question templates with explicit selectable options.")
  }
  if ((failureByOutcome.planning_exhausted ?? 0) > 0) {
    recommendations.push("Planner retries are exhausting: add deterministic fallback plans for the top failed prompt families.")
  }
  if (recommendations.length === 0) {
    recommendations.push("No dominant failure mode detected in this sample. Review top failed prompts and add targeted tests for each.")
  }

  return {
    analyzed: recent.length,
    appliedCount: success.length,
    failedCount: failures.length,
    failureRate: recent.length > 0 ? Number((failures.length / recent.length).toFixed(4)) : 0,
    failureByOutcome,
    failureByReasonCategory,
    topFailedPrompts,
    recommendations
  }
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
  await loadStateFromDisk()
  await loadTelemetryFromDisk()
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
