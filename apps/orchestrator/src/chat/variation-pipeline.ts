import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import type { FastifyBaseLogger } from "fastify"
import { z } from "zod"
import { type BlockType, type PageDoc, validateBlockProps } from "@avocadostudio-ai/shared"
import { buildVariationSystemPrompt } from "./prompts.js"
import { type AIProvider, type ModelKey, getPage } from "../state/session-state.js"
import { withSiteContext } from "../nlp/intent-detection.js"
import { coercePatchForBlock } from "../nlp/deterministic-planner.js"
import { openAIChatOptionsForModel } from "./planner.js"
import { extractJsonObject } from "../nlp/plan-normalizer.js"
import { type TokenUsage, extractUsage, estimateUsd, ZERO_USAGE } from "../telemetry/usage.js"
import { anthropicSystemPromptWithCache } from "./anthropic-cache.js"
import { resolveEffectiveProvider, resolveModelKeyForProvider, resolvePlannerSource } from "./provider-routing.js"
import {
  deriveVariationImageIntent,
  buildVariationImageQuery,
  buildVariationImagePrompt,
  generateVariationImageWithOpenAI,
  generateVariationImageWithGemini,
  resolveUnsplashImage
} from "../image/image-helpers.js"
import type { UnsplashImage } from "../variation-images.js"
import { firstUrlFromText, resolveEffectiveSlug } from "./chat-pipeline.js"
import { resolveDistinctUnsplashImage } from "../variation-images.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const variationRequestBodySchema = z.object({
  session: z.string().optional(),
  siteId: z.string().optional(),
  sitePurpose: z.string().optional(),
  siteHosting: z.string().optional(),
  businessContext: z.union([
    z.object({ purpose: z.string().optional(), tone: z.string().optional(), constraints: z.array(z.string()).optional() }),
    z.string()
  ]).optional(),
  siteContext: z.union([
    z.object({ siteId: z.string().optional(), siteName: z.string().optional(), purpose: z.string().optional(), hosting: z.string().optional(), tone: z.string().optional(), constraints: z.array(z.string()).optional() }),
    z.string()
  ]).optional(),
  slug: z.string().optional(),
  message: z.string().optional(),
  modelKey: z.enum(["fast", "balanced", "reasoning", "codex"]).optional(),
  provider: z.enum(["openai", "anthropic", "gemini"]).optional(),
  activeBlockId: z.string().optional(),
  activeBlockType: z.string().optional(),
  activeEditablePath: z.string().optional(),
  locale: z.string().optional(),
})

export type VariationRequestBody = z.infer<typeof variationRequestBodySchema>

export type VariationOption = {
  id: string
  title: string
  summary: string
  patch: Record<string, unknown>
  changedKeys: string[]
}

export type VariationResult = {
  status: "ok"
  summary: string
  blockId: string
  blockType: BlockType
  pageSlug: string
  baseProps: Record<string, unknown>
  variations: VariationOption[]
  suggestions?: string[]
  plannerSource: "openai" | "anthropic" | "gemini" | "demo"
  modelUsed: string
  modelKey: ModelKey
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    cacheCreationInputTokens?: number
    cacheReadInputTokens?: number
    estimatedUsd: number | null
  }
}

export type VariationIntent = "generate" | "regenerate" | "show"

// Ephemeral per-(session, blockId) cache so a "show variations" follow-up
// can return the previously-generated set instead of burning another LLM call.
type CachedVariations = { result: VariationResult; storedAt: number }
const VARIATION_CACHE_TTL_MS = 5 * 60_000
const lastVariationBySessionBlock = new Map<string, CachedVariations>()
const variationCacheKey = (session: string, blockId: string) => `${session}::${blockId}`

export function getCachedVariations(session: string, blockId: string): VariationResult | null {
  const key = variationCacheKey(session, blockId)
  const entry = lastVariationBySessionBlock.get(key)
  if (!entry) return null
  if (Date.now() - entry.storedAt > VARIATION_CACHE_TTL_MS) {
    lastVariationBySessionBlock.delete(key)
    return null
  }
  return entry.result
}

function rememberVariations(session: string, result: VariationResult) {
  lastVariationBySessionBlock.set(variationCacheKey(session, result.blockId), {
    result,
    storedAt: Date.now()
  })
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type VariationPipelineContext = {
  log: FastifyBaseLogger
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
}

let resolveUnsplashImageImpl = resolveUnsplashImage
export function setResolveUnsplashImageForTests(fn?: typeof resolveUnsplashImage) {
  resolveUnsplashImageImpl = fn ?? resolveUnsplashImage
}

type GenerateVariationImageFn = (args: {
  prompt: string
  altText: string
}) => Promise<UnsplashImage | null>

let generateVariationImageForTests: GenerateVariationImageFn | null = null
export function setGenerateVariationImageForTests(fn?: GenerateVariationImageFn) {
  generateVariationImageForTests = fn ?? null
}

type AiImageProvider = "openai" | "gemini"

function resolveAiImageProvider(): AiImageProvider {
  const raw = process.env.IMAGE_GEN_PROVIDER?.trim().toLowerCase()
  if (raw === "openai") return "openai"
  // Default: gemini. Falls back to openai at call time if Gemini key is missing.
  return "gemini"
}

async function generateVariationImage(args: {
  prompt: string
  altText: string
  log?: FastifyBaseLogger
}): Promise<UnsplashImage | null> {
  if (generateVariationImageForTests) {
    return generateVariationImageForTests({ prompt: args.prompt, altText: args.altText })
  }
  const provider = resolveAiImageProvider()
  const hasGemini = !!process.env.GOOGLE_GENAI_API_KEY?.trim()
  const hasOpenAI = !!process.env.OPENAI_API_KEY?.trim()

  if (provider === "gemini" && hasGemini) {
    return generateVariationImageWithGemini({
      prompt: args.prompt,
      altText: args.altText,
      aspectRatio: "landscape",
      quality: "draft",
      log: args.log
    })
  }
  if (hasOpenAI) {
    return generateVariationImageWithOpenAI({
      prompt: args.prompt,
      altText: args.altText,
      model: process.env.OPENAI_IMAGE_MODEL?.trim() || undefined,
      log: args.log
    })
  }
  if (hasGemini) {
    return generateVariationImageWithGemini({
      prompt: args.prompt,
      altText: args.altText,
      aspectRatio: "landscape",
      quality: "draft",
      log: args.log
    })
  }
  return null
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Variation count
// ---------------------------------------------------------------------------

const DEFAULT_VARIATION_COUNT = 3
const MAX_VARIATION_COUNT = 12

const VARIATION_NOUN_PATTERN = "(?:variations?|variants?|alternatives?|options)"

export function requestedVariationCount(message: string): number {
  const normalized = message.toLowerCase().replace(/-/g, " ")
  const numberMatch = normalized.match(new RegExp(`\\b(\\d{1,2})\\s+${VARIATION_NOUN_PATTERN}\\b`))
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
    const re = new RegExp(`\\b${word}\\s+${VARIATION_NOUN_PATTERN}\\b`, "i")
    if (re.test(normalized)) return value
  }
  return DEFAULT_VARIATION_COUNT
}

// ---------------------------------------------------------------------------
// Patch sanitization
// ---------------------------------------------------------------------------

function sanitizeVariationPatch(block: PageDoc["blocks"][number], patch: unknown): Record<string, unknown> | null {
  const safePatch = coercePatchForBlock(block, patch)
  if (Object.keys(safePatch).length === 0) return null
  const nextProps = { ...(block.props as Record<string, unknown>), ...safePatch }
  const validated = validateBlockProps(block.type as BlockType, nextProps)
  if (!validated.success) return null
  if (JSON.stringify(block.props) === JSON.stringify(validated.data)) return null
  return safePatch
}

// ---------------------------------------------------------------------------
// Image variation support
// ---------------------------------------------------------------------------

function supportsImageVariation(block: PageDoc["blocks"][number]) {
  return Object.prototype.hasOwnProperty.call(block.props, "imageUrl")
}

function prefersSameImageAcrossVariations(message: string) {
  const lower = message.toLowerCase()
  return (
    /\bsame\s+image\b/.test(lower) ||
    /\bsame\s+photo\b/.test(lower) ||
    /\bkeep\s+(the\s+)?same\s+image\b/.test(lower) ||
    /\buse\s+one\s+image\b/.test(lower) ||
    /\bsingle\s+image\b/.test(lower)
  )
}

type VariationImageContext = {
  explicitUrl: string | null
  imageIntent: ReturnType<typeof deriveVariationImageIntent>
  enforceUniqueImages: boolean
  noDuplicateRequested: boolean
}

function buildVariationImageContext(args: {
  block: PageDoc["blocks"][number]
  message: string
}): VariationImageContext {
  const explicitUrl = firstUrlFromText(args.message)
  const imageIntent = deriveVariationImageIntent({ message: args.message, block: args.block })
  const noDuplicateRequested =
    /\bno\s+duplicates?\b/i.test(args.message) ||
    /\bdo\s+not\s+reuse\b/i.test(args.message) ||
    /\bunique\s+images?\b/i.test(args.message)
  const enforceUniqueImages = !explicitUrl && !prefersSameImageAcrossVariations(args.message)
  return { explicitUrl: explicitUrl ?? null, imageIntent, enforceUniqueImages, noDuplicateRequested }
}

async function resolveVariationImage(args: {
  block: PageDoc["blocks"][number]
  imageCtx: VariationImageContext
  variationIndex: number
  usedImageUrls: Set<string>
  page?: PageDoc
  log?: FastifyBaseLogger
}): Promise<UnsplashImage | null> {
  const { imageCtx, variationIndex } = args
  if (imageCtx.explicitUrl) {
    return { url: imageCtx.explicitUrl, alt: `Image for ${args.block.type} variation`, query: "" }
  }
  if (imageCtx.imageIntent.provider === "llm") {
    const blockProps = args.block.props as Record<string, unknown>
    const heading = typeof blockProps.heading === "string" ? blockProps.heading : ""
    const subheading = typeof blockProps.subheading === "string" ? blockProps.subheading : ""
    const sectionContext = [args.block.type, heading, subheading].filter(Boolean).join(" — ")
    const pageContext = args.page ? `${args.page.title} (${args.page.slug})` : undefined
    const prompt = buildVariationImagePrompt({
      intent: imageCtx.imageIntent,
      blockType: args.block.type,
      variationIndex,
      sectionContext,
      pageContext
    })
    return generateVariationImage({
      prompt,
      altText: `AI-generated ${args.block.type} image variation ${variationIndex + 1}`,
      log: args.log
    })
  }
  const query = buildVariationImageQuery(imageCtx.imageIntent, variationIndex)
  if (imageCtx.enforceUniqueImages) {
    return resolveDistinctUnsplashImage({
      query,
      variationIndex,
      usedImageUrls: args.usedImageUrls,
      resolveImage: async (queryValue, options) =>
        resolveUnsplashImageImpl(queryValue, {
          variationIndex: options?.variationIndex,
          subjectKeywords: imageCtx.imageIntent.subjectKeywords,
          usedImageUrls: args.usedImageUrls
        }, { logger: args.log }),
      maxAttempts: imageCtx.noDuplicateRequested ? 8 : 5
    })
  }
  return resolveUnsplashImageImpl(
    query,
    {
      variationIndex,
      subjectKeywords: imageCtx.imageIntent.subjectKeywords,
      usedImageUrls: imageCtx.noDuplicateRequested ? args.usedImageUrls : undefined
    },
    { logger: args.log }
  )
}

function applyResolvedImageToPatch(args: {
  patch: Record<string, unknown>
  resolved: UnsplashImage | null
  llmAuthoredImageUrl: boolean
}): Record<string, unknown> {
  const patch = { ...args.patch }
  if (args.resolved) {
    patch.imageUrl = args.resolved.url
    if (!Object.prototype.hasOwnProperty.call(patch, "imageAlt")) {
      patch.imageAlt = args.resolved.alt
    }
  } else if (
    args.llmAuthoredImageUrl &&
    !Object.prototype.hasOwnProperty.call(patch, "imageUrl") &&
    Object.prototype.hasOwnProperty.call(patch, "imageAlt")
  ) {
    // LLM authored a fake imageUrl + matching alt; real resolution failed, so
    // drop the orphan alt too to avoid describing the wrong (existing) image.
    delete patch.imageAlt
  }
  return patch
}

export async function withDefaultImageVariations(args: {
  block: PageDoc["blocks"][number]
  message: string
  variations: VariationOption[]
  page?: PageDoc
  log?: FastifyBaseLogger
}): Promise<VariationOption[]> {
  if (!supportsImageVariation(args.block)) return args.variations
  const imageCtx = buildVariationImageContext({ block: args.block, message: args.message })
  const usedImageUrls = new Set<string>()

  const out: VariationOption[] = []
  for (const [variationIndex, variation] of args.variations.entries()) {
    const patchWithoutLlmImage = { ...variation.patch }
    const llmAuthoredImageUrl = Object.prototype.hasOwnProperty.call(patchWithoutLlmImage, "imageUrl")
    if (llmAuthoredImageUrl && !imageCtx.explicitUrl) {
      delete patchWithoutLlmImage.imageUrl
    }

    const resolved = await resolveVariationImage({
      block: args.block,
      imageCtx,
      variationIndex,
      usedImageUrls,
      page: args.page,
      log: args.log
    })
    if (resolved) usedImageUrls.add(resolved.url)

    const patch = applyResolvedImageToPatch({
      patch: patchWithoutLlmImage,
      resolved,
      llmAuthoredImageUrl
    })

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

// ---------------------------------------------------------------------------
// Streaming variation images — open modal immediately, fill images as each
// generation completes. Used by the /chat/variations/stream SSE route so the
// user sees variants within ~1s instead of waiting for the slowest image.
// ---------------------------------------------------------------------------

export type VariationImageUpdate = {
  variationId: string
  index: number
  patch: Record<string, unknown>
  changedKeys: string[]
  imageUrl?: string
  imageAlt?: string
}

export type StreamingVariationsPlan = {
  initial: VariationOption[]
  run: (onProgress: (update: VariationImageUpdate) => void) => Promise<VariationOption[]>
}

export function planDefaultImageVariations(args: {
  block: PageDoc["blocks"][number]
  message: string
  variations: VariationOption[]
  page?: PageDoc
  log?: FastifyBaseLogger
}): StreamingVariationsPlan {
  if (!supportsImageVariation(args.block)) {
    return {
      initial: args.variations,
      run: async () => args.variations
    }
  }

  const imageCtx = buildVariationImageContext({ block: args.block, message: args.message })

  type PreparedVariation = {
    source: VariationOption
    variationIndex: number
    basePatch: Record<string, unknown>  // patch with any LLM-authored imageUrl stripped, no real image yet
    llmAuthoredImageUrl: boolean
    initial: VariationOption | null  // sanitized version without image (for skeleton modal)
  }

  const prepared: PreparedVariation[] = args.variations.map((variation, variationIndex) => {
    const basePatch = { ...variation.patch }
    const llmAuthoredImageUrl = Object.prototype.hasOwnProperty.call(basePatch, "imageUrl")
    if (llmAuthoredImageUrl && !imageCtx.explicitUrl) {
      delete basePatch.imageUrl
    }
    const initialSanitized = sanitizeVariationPatch(args.block, basePatch)
    const initial: VariationOption | null = initialSanitized
      ? { ...variation, patch: initialSanitized, changedKeys: Object.keys(initialSanitized) }
      : { ...variation, patch: basePatch, changedKeys: Object.keys(basePatch) }
    // Note: when the text-only patch fails sanitization (e.g. it becomes empty
    // after stripping imageUrl), we still keep the variation so the modal can
    // show it while the image resolves. Final sanitization happens in run().
    return { source: variation, variationIndex, basePatch, llmAuthoredImageUrl, initial }
  })

  const initial = prepared.map((p) => p.initial!).filter(Boolean) as VariationOption[]

  const run: StreamingVariationsPlan["run"] = async (onProgress) => {
    const usedImageUrls = new Set<string>()
    const results = await Promise.all(prepared.map(async (p) => {
      const resolved = await resolveVariationImage({
        block: args.block,
        imageCtx,
        variationIndex: p.variationIndex,
        usedImageUrls,
        page: args.page,
        log: args.log
      }).catch((err) => {
        args.log?.warn({ err, variationIndex: p.variationIndex }, "variation image resolution failed")
        return null
      })
      if (resolved) usedImageUrls.add(resolved.url)

      const patch = applyResolvedImageToPatch({
        patch: p.basePatch,
        resolved,
        llmAuthoredImageUrl: p.llmAuthoredImageUrl
      })
      const sanitized = sanitizeVariationPatch(args.block, patch)
      const finalOption: VariationOption | null = sanitized
        ? { ...p.source, patch: sanitized, changedKeys: Object.keys(sanitized) }
        : null

      if (finalOption) {
        onProgress({
          variationId: p.source.id,
          index: p.variationIndex,
          patch: finalOption.patch,
          changedKeys: finalOption.changedKeys,
          ...(resolved ? { imageUrl: resolved.url, imageAlt: resolved.alt } : {})
        })
      }
      return finalOption
    }))
    return results.filter((r): r is VariationOption => r !== null)
  }

  return { initial, run }
}

// ---------------------------------------------------------------------------
// Text key inference
// ---------------------------------------------------------------------------

function inferVariationTextKey(block: PageDoc["blocks"][number]) {
  const preferred = ["heading", "title", "subheading", "description", "body", "ctaText", "imageAlt"]
  const props = block.props as Record<string, unknown>
  for (const key of preferred) {
    if (typeof props[key] === "string" && (props[key] as string).trim().length > 0) return key
  }
  const firstString = Object.entries(props).find(([, value]) => typeof value === "string" && value.trim().length > 0)
  return firstString?.[0] ?? null
}

// ---------------------------------------------------------------------------
// Variation constraints
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Deterministic variations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OpenAI variation generation
// ---------------------------------------------------------------------------

async function generateVariationsWithOpenAI(args: {
  block: PageDoc["blocks"][number]
  message: string
  model: string
  modelKey: ModelKey
  count: number
  locale?: string
}): Promise<{ variations: VariationOption[]; usage: TokenUsage }> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const props = args.block.props as Record<string, unknown>
  const allowedKeys = Object.keys(props)
  const constraints = variationConstraints(args.message, args.block)
  const system = buildVariationSystemPrompt({
    count: args.count,
    keepTitle: constraints.keepTitle,
    cardsOnly: constraints.cardsOnly,
    blockType: args.block.type,
    locale: args.locale,
  })

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

  const usage = extractUsage(completion)
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
  return { variations: out, usage }
}

// ---------------------------------------------------------------------------
// Anthropic variation generation
// ---------------------------------------------------------------------------

async function generateVariationsWithAnthropic(args: {
  block: PageDoc["blocks"][number]
  message: string
  model: string
  modelKey: ModelKey
  count: number
  locale?: string
}): Promise<{ variations: VariationOption[]; usage: TokenUsage }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const props = args.block.props as Record<string, unknown>
  const allowedKeys = Object.keys(props)
  const constraints = variationConstraints(args.message, args.block)
  const system = buildVariationSystemPrompt({
    count: args.count,
    keepTitle: constraints.keepTitle,
    cardsOnly: constraints.cardsOnly,
    blockType: args.block.type,
    locale: args.locale,
  })

  const user = {
    request: args.message,
    blockId: args.block.id,
    blockType: args.block.type,
    currentProps: props,
    allowedPatchKeys: allowedKeys
  }

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 4096,
    system: anthropicSystemPromptWithCache(system),
    messages: [
      { role: "user", content: JSON.stringify(user) }
    ],
  })

  const usage = extractUsage(response)
  const textBlock = response.content.find((b) => b.type === "text")
  const rawText = textBlock && "text" in textBlock ? textBlock.text : ""
  const jsonText = extractJsonObject(rawText)
  const parsed = jsonText ? parseJsonMaybe(jsonText) as { variations?: Array<{ title?: unknown; summary?: unknown; patch?: unknown }> } | null : null
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
  return { variations: out, usage }
}

// ---------------------------------------------------------------------------
// Variation pipeline
// ---------------------------------------------------------------------------

type PreparedVariationsContext = {
  contextualMessage: string
  effectiveSlug: string
  page: PageDoc
  selected: PageDoc["blocks"][number]
  plannerSource: "openai" | "anthropic" | "gemini" | "demo"
  modelUsed: string
  modelKey: ModelKey
  variations: VariationOption[]
  generatorUsage?: TokenUsage
  count: number
}

async function prepareTextVariations(
  ctx: VariationPipelineContext,
  body: VariationRequestBody
): Promise<{ code: number; payload?: { error: string }; prepared?: PreparedVariationsContext }> {
  if (!body.session || !body.slug || !body.message) {
    return { code: 400, payload: { error: "session, slug, and message are required" } }
  }
  const contextualMessage = withSiteContext(body.message, {
    sitePurpose: body.sitePurpose,
    siteHosting: body.siteHosting,
    businessContext: body.businessContext,
    siteContext: body.siteContext
  })

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

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = resolveEffectiveProvider({
    requestedProvider,
    availableProviders: ctx.availableProviders,
    fallbackProvider: "openai"
  })
  const modelKey = resolveModelKeyForProvider({
    requestedModelKey: body.modelKey,
    provider,
    modelLookup: ctx.modelLookup,
    defaultModelKey: (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  })
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const count = requestedVariationCount(contextualMessage)
  const plannerSource: "openai" | "anthropic" | "gemini" | "demo" = resolvePlannerSource(provider)

  let variations: VariationOption[] = []
  let generatorUsage: TokenUsage | undefined
  if (plannerSource === "anthropic") {
    try {
      const result = await generateVariationsWithAnthropic({
        block: selected,
        message: contextualMessage,
        model: modelUsed,
        modelKey,
        count,
        locale: body.locale
      })
      variations = result.variations
      generatorUsage = result.usage
    } catch (err) {
      ctx.log.warn(
        { err, provider: "anthropic", model: modelUsed, blockType: selected.type },
        "variation pipeline: anthropic generation failed; falling back to deterministic"
      )
      variations = []
    }
  } else if (plannerSource === "openai") {
    try {
      const result = await generateVariationsWithOpenAI({
        block: selected,
        message: contextualMessage,
        model: modelUsed,
        modelKey,
        count,
        locale: body.locale
      })
      variations = result.variations
      generatorUsage = result.usage
    } catch (err) {
      ctx.log.warn(
        { err, provider: "openai", model: modelUsed, blockType: selected.type },
        "variation pipeline: openai generation failed; falling back to deterministic"
      )
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

  return {
    code: 200,
    prepared: {
      contextualMessage,
      effectiveSlug,
      page,
      selected,
      plannerSource,
      modelUsed,
      modelKey,
      variations,
      generatorUsage,
      count
    }
  }
}

function summaryForIntent(intent: VariationIntent, count: number, blockType: string): string {
  if (intent === "regenerate") return `Generated ${count} fresh variations for ${blockType}.`
  if (intent === "show") return `Showing your ${count} variations for ${blockType}.`
  return `Generated ${count} variations for ${blockType}.`
}

const POST_VARIATION_SUGGESTIONS = [
  "Generate different variations",
  "Try a more playful tone",
  "Try a more formal tone"
]

function buildVariationResult(args: {
  prepared: PreparedVariationsContext
  variations: VariationOption[]
  intent?: VariationIntent
}): VariationResult {
  const { prepared, variations } = args
  const intent: VariationIntent = args.intent ?? "generate"
  const { selected, effectiveSlug, plannerSource, modelUsed, modelKey, generatorUsage } = prepared
  return {
    status: "ok",
    summary: summaryForIntent(intent, variations.length, selected.type),
    blockId: selected.id,
    blockType: selected.type,
    pageSlug: effectiveSlug,
    baseProps: structuredClone(selected.props as Record<string, unknown>),
    variations,
    suggestions: POST_VARIATION_SUGGESTIONS,
    plannerSource,
    modelUsed,
    modelKey,
    ...(generatorUsage ? {
      usage: {
        inputTokens: generatorUsage.inputTokens,
        outputTokens: generatorUsage.outputTokens,
        totalTokens: generatorUsage.totalTokens,
        ...(typeof generatorUsage.cacheCreationInputTokens === "number"
          ? { cacheCreationInputTokens: generatorUsage.cacheCreationInputTokens }
          : {}),
        ...(typeof generatorUsage.cacheReadInputTokens === "number"
          ? { cacheReadInputTokens: generatorUsage.cacheReadInputTokens }
          : {}),
        estimatedUsd: estimateUsd(modelUsed, generatorUsage)
      }
    } : {})
  }
}

function resolveLlmIntent(session: string | undefined, blockId: string, explicit: VariationIntent | undefined): VariationIntent {
  if (explicit && explicit !== "show") return explicit
  if (session && getCachedVariations(session, blockId)) return "regenerate"
  return "generate"
}

export async function runVariationPipeline(
  ctx: VariationPipelineContext,
  body: VariationRequestBody,
  options?: { intent?: VariationIntent }
): Promise<{ code: number; payload: VariationResult | { error: string } }> {
  const prep = await prepareTextVariations(ctx, body)
  if (prep.code !== 200 || !prep.prepared) {
    return { code: prep.code, payload: prep.payload ?? { error: "unknown error" } }
  }
  const { prepared } = prep
  const variations = await withDefaultImageVariations({
    block: prepared.selected,
    message: prepared.contextualMessage,
    variations: prepared.variations,
    page: prepared.page,
    log: ctx.log
  })
  if (variations.length === 0) {
    return {
      code: 400,
      payload: { error: "Could not generate valid variations for this block. Try a more specific instruction." }
    }
  }
  const intent = resolveLlmIntent(body.session, prepared.selected.id, options?.intent)
  const result = buildVariationResult({ prepared, variations, intent })
  if (body.session) rememberVariations(body.session, result)
  return { code: 200, payload: result }
}

export type VariationStreamPipelineHooks = {
  onInitial: (result: VariationResult & { imagesPending: boolean }) => void
  onImageResolved: (update: VariationImageUpdate) => void
}

export async function runVariationPipelineStreaming(
  ctx: VariationPipelineContext,
  body: VariationRequestBody,
  hooks: VariationStreamPipelineHooks,
  options?: { intent?: VariationIntent }
): Promise<{ code: number; payload: VariationResult | { error: string } }> {
  const prep = await prepareTextVariations(ctx, body)
  if (prep.code !== 200 || !prep.prepared) {
    return { code: prep.code, payload: prep.payload ?? { error: "unknown error" } }
  }
  const { prepared } = prep

  const plan = planDefaultImageVariations({
    block: prepared.selected,
    message: prepared.contextualMessage,
    variations: prepared.variations,
    page: prepared.page,
    log: ctx.log
  })

  if (plan.initial.length === 0) {
    return {
      code: 400,
      payload: { error: "Could not generate valid variations for this block. Try a more specific instruction." }
    }
  }

  const intent = resolveLlmIntent(body.session, prepared.selected.id, options?.intent)
  const imagesPending = supportsImageVariation(prepared.selected)
  hooks.onInitial({
    ...buildVariationResult({ prepared, variations: plan.initial, intent }),
    imagesPending
  })

  const finalVariations = await plan.run((update) => hooks.onImageResolved(update))

  if (finalVariations.length === 0) {
    return {
      code: 400,
      payload: { error: "Could not generate valid variations for this block. Try a more specific instruction." }
    }
  }
  const result = buildVariationResult({ prepared, variations: finalVariations, intent })
  if (body.session) rememberVariations(body.session, result)
  return { code: 200, payload: result }
}

