import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import OpenAI from "openai"
import type { PageDoc } from "@ai-site-editor/shared"
import { type UnsplashImage, type UnsplashResolveOptions } from "../variation-images.js"
import { toSeedSlug } from "../nlp/intent-helpers.js"

// ---------------------------------------------------------------------------
// Minimal logger interface compatible with Fastify's app.log
// ---------------------------------------------------------------------------

export type ImageLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void
  warn: (obj: Record<string, unknown>, msg: string) => void
}

// ---------------------------------------------------------------------------
// Query normalisation & keyword extraction
// ---------------------------------------------------------------------------

export function normalizeUnsplashQuery(raw: string) {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

export function extractUnsplashQuery(message: string) {
  const cleanMessage = message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const aboutBeforeFromUnsplash = cleanMessage.match(/\b(?:about|of|with|for)\s+([^,.!?;\n]+?)\s+(?:from|using|via)\s+unsplash\b/i)
  const fromUnsplashMatch = cleanMessage.match(/\b(?:from|using|via)\s+unsplash\b[^.?!\n]*?(?:showing|of|with|for)?[^\S\n]*([^,.!?;\n]+)/i)
  const unsplashMatch = cleanMessage.match(/\bunsplash\b[^.?!\n]*?(?:showing|of|with|for)\s+([^,.!?;\n]+)/i)
  const replaceImageWith = cleanMessage.match(
    /\b(?:replace|swap|change|update|set)\s+(?:the\s+)?(?:hero\s+)?(?:image|photo|picture)\s+(?:to|with)\s+([^,.!?;\n]+)/i
  )
  const replaceImageWithGerman = cleanMessage.match(
    /\b(?:ersetze|ersetzen|aendere|ändere|tausche|tauschen)\s+(?:das|die|den)?\s*(?:hero\s*)?(?:bild|foto|image)\s+(?:durch|mit|zu)\s+([^,.!?;\n]+)/i
  )
  const quotedWithImageContext =
    cleanMessage.match(/\b(?:image|photo|picture|bild|foto)\b[^"\n]{0,60}"([^"]+)"/i)?.[1] ??
    cleanMessage.match(/^"([^"]+)"$/)?.[1]
  const candidate =
    aboutBeforeFromUnsplash?.[1] ??
    fromUnsplashMatch?.[1] ??
    unsplashMatch?.[1] ??
    replaceImageWith?.[1] ??
    replaceImageWithGerman?.[1] ??
    quotedWithImageContext
  if (!candidate) return undefined
  const cleaned = candidate
    .replace(/\b(an?|the|ein(?:e|en|em|er|es)?|der|die|das|den|dem|des)\s+/gi, "")
    .replace(/\b(image|photo|picture)\b/gi, "")
    .replace(/\b(of|with|showing|for|mit|von|fuer|für)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
  const normalized = normalizeUnsplashQuery(cleaned)
  return normalized.length > 0 ? normalized : undefined
}

/**
 * Detect explicit image generation intent in a message (e.g. "generate a new image", "new photo").
 * Returns true for phrases that clearly request creating/replacing an image, but NOT for
 * property edits like "change the image alt text".
 */
export function isExplicitImageGenRequest(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    /\b(?:generate|create)\b[^.!?\n]*\b(?:image|photo|picture)\b/i.test(lower) ||
    /\bnew\s+(?:hero\s+)?(?:image|photo|picture)\b/i.test(lower) ||
    /\breplace\b[^.!?\n]*\b(?:image|photo|picture)\b/i.test(lower)
  )
}

/**
 * Extract a detailed image description/prompt from a user message.
 * Matches patterns like "generate a new image: [full description]".
 * Returns the description (typically a rich prompt for AI image generation) or undefined.
 */
export function extractImagePromptFromMessage(message: string): string | undefined {
  // "generate/create/make a new image: [detailed description]"
  const colonMatch = message.match(
    /\b(?:generate|create|make|new)\b[^.!?\n]*?\b(?:image|photo|picture)\s*[:]\s*(.+)/is
  )
  if (colonMatch?.[1]) {
    const desc = colonMatch[1].trim()
    if (desc.length > 20) return desc
  }
  return undefined
}

const IMAGE_QUERY_STOPWORDS = new Set([
  "a", "an", "and", "background", "backgrounds", "different", "for", "from",
  "image", "images", "of", "on", "photo", "photos", "picture", "pictures",
  "the", "types", "unsplash", "various", "varied", "with"
])

export function imageKeywordsFromQuery(raw: string, max = 3): string[] {
  const tokens = normalizeUnsplashQuery(raw)
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && !IMAGE_QUERY_STOPWORDS.has(part))
  const unique = Array.from(new Set(tokens))
  return unique.slice(0, max)
}

// ---------------------------------------------------------------------------
// Hero image query builder
// ---------------------------------------------------------------------------

export function heroImageQueryFromContext(args: {
  message: string
  currentPage: PageDoc
  targetBlock: PageDoc["blocks"][number]
  patchCandidate?: Record<string, unknown>
}) {
  // Strip [site context]...[/site context] metadata to avoid extracting metadata as query
  const cleanMessage = args.message.replace(/\n?\[site context\][\s\S]*?\[\/site context\]\s*$/i, "").trim()
  const explicit = extractUnsplashQuery(cleanMessage)
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

// ---------------------------------------------------------------------------
// Variation image intent & prompt builders
// ---------------------------------------------------------------------------

export type VariationImageIntent = {
  baseQuery: string
  subjectKeywords: string[]
  varyBackgrounds: boolean
  styleTerms: string[]
  provider: "unsplash" | "llm"
  backgroundTerms: string[]
}

export function deriveVariationImageIntent(args: { message: string; block: PageDoc["blocks"][number] }): VariationImageIntent {
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

export function buildVariationImageQuery(intent: VariationImageIntent, variationIndex: number): string {
  const base = [intent.baseQuery, ...intent.styleTerms].filter(Boolean).join(" ")
  if (!intent.varyBackgrounds) return normalizeUnsplashQuery(base)
  const backgrounds = ["studio background", "wood table background", "kitchen background", "dark background", "outdoor background"]
  const chosen = backgrounds[variationIndex % backgrounds.length]
  return normalizeUnsplashQuery(`${base} ${chosen}`)
}

export function buildVariationImagePrompt(args: {
  intent: VariationImageIntent
  blockType: string
  variationIndex: number
  sectionContext?: string
  pageContext?: string
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

  const lines = [
    "Use case: precise-object-edit",
    `Asset type: website ${args.blockType} image`
  ]
  if (args.pageContext) lines.push(`Page: ${args.pageContext}`)
  if (args.sectionContext) lines.push(`Section: ${args.sectionContext}`)
  lines.push(
    `Primary request: create a high-quality hero image featuring ${subject}`,
    `Scene/background: ${chosenBackground}`,
    `Style/medium: ${style}`,
    "Composition/framing: landscape composition with clear focal subject and breathing room",
    "Lighting/mood: clean, editorial, realistic",
    "Constraints: no text, no logos, no watermark",
    "Avoid: clutter, over-saturation, distorted objects"
  )
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Image generation & resolution
// ---------------------------------------------------------------------------

export async function generateVariationImageWithOpenAI(args: {
  prompt: string
  altText: string
  log?: ImageLogger
}): Promise<UnsplashImage | null> {
  if (!process.env.OPENAI_API_KEY) {
    args.log?.warn({ event: "openai_image_skip", reason: "no_api_key" }, "Skipping OpenAI image generation: OPENAI_API_KEY not set")
    return null
  }

  const model = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1"
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const generatedImageDir = process.env.ORCHESTRATOR_GENERATED_IMAGE_DIR ?? resolve(process.cwd(), "../../.data/generated-images")
  const orchestratorPublicOrigin = (process.env.ORCHESTRATOR_PUBLIC_ORIGIN ?? "http://localhost:4200").replace(/\/+$/, "")

  args.log?.info({ event: "openai_image_start", model, promptLength: args.prompt.length }, "Starting OpenAI image generation")

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
  } catch (err) {
    args.log?.warn(
      { event: "openai_image_error", error: err instanceof Error ? err.message : String(err) },
      "OpenAI image generation failed"
    )
    return null
  }
}

export async function resolveUnsplashImage(
  query: string,
  options?: UnsplashResolveOptions,
  logContext?: { chatRequestId?: string; logger?: ImageLogger }
): Promise<UnsplashImage | null> {
  const safeQuery = normalizeUnsplashQuery(query)
  if (!safeQuery) return null
  const variationIndex =
    typeof options?.variationIndex === "number" && Number.isInteger(options.variationIndex) && options.variationIndex >= 0
      ? options.variationIndex
      : 0
  const page = variationIndex + 1
  const log = logContext?.logger

  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim()
  log?.info(
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
          log?.info(
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
      log?.warn(
        {
          event: "hero_image_resolve_unsplash_error",
          chatRequestId: logContext?.chatRequestId,
          query: safeQuery
        },
        "Unsplash API lookup failed; falling back to seeded source"
      )
    }
  }

  const usedImageUrls = options?.usedImageUrls
  let picsumPage = page
  let seed = toSeedSlug(`${safeQuery}-${picsumPage}`) || "hero-image"
  let sourceUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/1600/900`

  if (usedImageUrls) {
    for (let attempt = 0; attempt < 3 && usedImageUrls.has(sourceUrl); attempt++) {
      picsumPage++
      seed = toSeedSlug(`${safeQuery}-${picsumPage}`) || "hero-image"
      sourceUrl = `https://picsum.photos/seed/${encodeURIComponent(seed)}/1600/900`
    }
  }

  log?.warn(
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
