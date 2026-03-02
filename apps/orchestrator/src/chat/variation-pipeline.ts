import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import type { FastifyBaseLogger } from "fastify"
import { type BlockType, type PageDoc, validateBlockProps } from "@ai-site-editor/shared"
import { type AIProvider, type ModelKey, getPage } from "../state/session-state.js"
import { withSiteContext } from "../nlp/intent-detection.js"
import { coercePatchForBlock } from "../nlp/deterministic-planner.js"
import { openAIChatOptionsForModel } from "./planner.js"
import { extractJsonObject } from "../nlp/plan-normalizer.js"
import { type TokenUsage, extractUsage, estimateUsd, ZERO_USAGE } from "../telemetry/usage.js"
import {
  deriveVariationImageIntent,
  buildVariationImageQuery,
  buildVariationImagePrompt,
  generateVariationImageWithOpenAI,
  resolveUnsplashImage
} from "../image/image-helpers.js"
import { firstUrlFromText, resolveEffectiveSlug } from "./chat-pipeline.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VariationRequestBody = {
  session?: string
  siteId?: string
  sitePurpose?: string
  siteHosting?: string
  slug?: string
  message?: string
  modelKey?: ModelKey
  provider?: AIProvider
  activeBlockId?: string
  activeBlockType?: string
  activeEditablePath?: string
}

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
  plannerSource: "openai" | "anthropic" | "demo"
  modelUsed: string
  modelKey: ModelKey
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedUsd: number | null }
}

// ---------------------------------------------------------------------------
// Pipeline context
// ---------------------------------------------------------------------------

export type VariationPipelineContext = {
  log: FastifyBaseLogger
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  availableProviders: AIProvider[]
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

async function withDefaultImageVariations(args: {
  block: PageDoc["blocks"][number]
  message: string
  variations: VariationOption[]
  page?: PageDoc
  log?: FastifyBaseLogger
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
      const blockProps = args.block.props as Record<string, unknown>
      const heading = typeof blockProps.heading === "string" ? blockProps.heading : ""
      const subheading = typeof blockProps.subheading === "string" ? blockProps.subheading : ""
      const sectionContext = [args.block.type, heading, subheading].filter(Boolean).join(" — ")
      const pageContext = args.page ? `${args.page.title} (${args.page.slug})` : undefined
      const prompt = buildVariationImagePrompt({
        intent: imageIntent,
        blockType: args.block.type,
        variationIndex,
        sectionContext,
        pageContext
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
      }, { logger: args.log })
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
}): Promise<{ variations: VariationOption[]; usage: TokenUsage }> {
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
}): Promise<{ variations: VariationOption[]; usage: TokenUsage }> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
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

  const response = await client.messages.create({
    model: args.model,
    max_tokens: 4096,
    system,
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

export async function runVariationPipeline(
  ctx: VariationPipelineContext,
  body: VariationRequestBody
): Promise<{ code: number; payload: VariationResult | { error: string } }> {
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

  const requestedProvider = body.provider ?? (ctx.availableProviders[0] as AIProvider | undefined)
  const provider: AIProvider = requestedProvider && ctx.availableProviders.includes(requestedProvider) ? requestedProvider : "openai"
  const modelKey = body.modelKey && ctx.modelLookup[provider][body.modelKey] ? body.modelKey : (process.env.OPENAI_MODEL_KEY as ModelKey | undefined) ?? "balanced"
  const modelUsed = ctx.modelLookup[provider][modelKey]
  const count = requestedVariationCount(contextualMessage)
  const plannerSource: "openai" | "anthropic" | "demo" =
    provider === "anthropic" && process.env.ANTHROPIC_API_KEY ? "anthropic" :
    provider === "openai" && process.env.OPENAI_API_KEY ? "openai" :
    process.env.OPENAI_API_KEY ? "openai" :
    process.env.ANTHROPIC_API_KEY ? "anthropic" : "demo"

  let variations: VariationOption[] = []
  let generatorUsage: TokenUsage | undefined
  if (plannerSource === "anthropic") {
    try {
      const result = await generateVariationsWithAnthropic({
        block: selected,
        message: contextualMessage,
        model: modelUsed,
        modelKey,
        count
      })
      variations = result.variations
      generatorUsage = result.usage
    } catch {
      variations = []
    }
  } else if (plannerSource === "openai") {
    try {
      const result = await generateVariationsWithOpenAI({
        block: selected,
        message: contextualMessage,
        model: modelUsed,
        modelKey,
        count
      })
      variations = result.variations
      generatorUsage = result.usage
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
    variations,
    page,
    log: ctx.log
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
      modelKey,
      ...(generatorUsage ? {
        usage: {
          inputTokens: generatorUsage.inputTokens,
          outputTokens: generatorUsage.outputTokens,
          totalTokens: generatorUsage.totalTokens,
          estimatedUsd: estimateUsd(modelUsed, generatorUsage)
        }
      } : {})
    }
  }
}
