import { generateVariationImageWithOpenAI, generateVariationImageWithGemini, recordImageGenDuration, estimatedImageGenMs } from "../../image/image-helpers.js"
import { getPage } from "../../state/session-state.js"
import type { ToolManifest, ToolHandler } from "../types.js"

type ImageGenerateInput = {
  prompt: string
  aspectRatio?: "landscape" | "square" | "portrait"
  quality?: "draft" | "final"
  style?: string
  background?: "transparent" | "opaque" | "auto"
  outputFormat?: "png" | "webp" | "jpeg"
  blockType?: string
  blockId?: string
  pageSlug?: string
}

const ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  landscape: "1536x1024",
  square: "1024x1024",
  portrait: "1024x1536"
}

const SIZE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1024": { width: 1024, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 }
}

const COMPOSITION_HINTS: Record<string, string> = {
  Hero: "Full-width hero section — landscape, cinematic, attention-grabbing",
  Banner: "Banner strip — wide landscape, clean with space for overlay text",
  CTA: "Call-to-action section — atmospheric, supportive background",
  Card: "Card thumbnail — balanced square or portrait composition, focused subject",
  CardGrid: "Card grid thumbnail — balanced, consistent style across cards",
  FeatureGrid: "Feature illustration — clean, focused, minimal background",
  Gallery: "Gallery image — well-composed, standalone photograph",
  Carousel: "Carousel slide — landscape, visually striking",
  TwoColumn: "Two-column layout image — balanced composition, clear subject",
}

/**
 * Enrich a bare prompt with block/page context for better image generation.
 */
function enrichPromptWithContext(basePrompt: string, ctx: {
  session?: string
  blockType?: string
  blockId?: string
  pageSlug?: string
  style?: string
  background?: string
}): string {
  const parts: string[] = []

  if (ctx.blockType) {
    parts.push(`Image for: ${ctx.blockType} block`)
    const hint = COMPOSITION_HINTS[ctx.blockType]
    if (hint) parts.push(`Composition: ${hint}`)
  }

  // Look up block content for richer context
  if (ctx.session && ctx.blockId && ctx.pageSlug) {
    try {
      const page = getPage(ctx.session, ctx.pageSlug)
      if (page) {
        if (page.title) parts.push(`Page: "${page.title}"`)
        const block = page.blocks.find(b => b.id === ctx.blockId)
        if (block) {
          const props = block.props as Record<string, unknown>
          const heading = typeof props.heading === "string" ? props.heading : ""
          const subheading = typeof props.subheading === "string" ? props.subheading : ""
          const title = typeof props.title === "string" ? props.title : ""
          if (heading) parts.push(`Block heading: "${heading}"`)
          if (subheading) parts.push(`Block subheading: "${subheading}"`)
          if (title && title !== heading) parts.push(`Block title: "${title}"`)
        }
      }
    } catch {
      // Session lookup may fail — just skip context enrichment
    }
  }

  parts.push(`\nUser request: ${basePrompt}`)

  if (ctx.style) parts.push(`Style: ${ctx.style}`)
  if (ctx.background === "transparent") parts.push("Background: transparent (no background, isolated subject)")
  parts.push("Constraints: no text overlays, no logos, no watermarks")

  return parts.join("\n")
}

export const imageGenerateManifest: ToolManifest = {
  name: "image.generate",
  description:
    "Generate an AI image from a text prompt. Default to quality 'draft'. Use 'final' only when the user explicitly asks for high quality, polished, or production-ready images.",
  capability: "read",
  timeoutMs: 90000,
  retryPolicy: { maxAttempts: 1 },
  idempotent: false,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "Detailed text prompt describing the image to generate" },
      aspectRatio: {
        type: "string",
        enum: ["landscape", "square", "portrait"],
        description: "Aspect ratio of the generated image (default: landscape)"
      },
      quality: {
        type: "string",
        enum: ["draft", "final"],
        description: "Image quality tier: 'draft' for fast previews, 'final' for production-ready"
      },
      style: { type: "string", description: "Optional style guidance (e.g. 'photorealistic', 'illustration')" },
      background: {
        type: "string",
        enum: ["transparent", "opaque", "auto"],
        description: "Background mode: 'transparent' for cutout/isolated subjects (logos, icons, product shots), 'opaque' for full scenes, 'auto' lets the model decide (default: auto)"
      },
      outputFormat: {
        type: "string",
        enum: ["png", "webp", "jpeg"],
        description: "Output image format (default: png). Use png for transparency, webp for smaller files, jpeg for photos."
      },
      blockType: { type: "string", description: "Block type the image is for (e.g. 'Hero', 'Card') — helps match composition to layout" },
      blockId: { type: "string", description: "Block ID — used to look up block content for context-aware generation" },
      pageSlug: { type: "string", description: "Page slug — used with blockId to look up surrounding content" },
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["imageUrl", "alt", "width", "height"],
    properties: {
      imageUrl: { type: "string" },
      alt: { type: "string" },
      width: { type: "integer" },
      height: { type: "integer" }
    }
  }
}

export const imageGenerateHandler: ToolHandler = async ({ input, context, signal }) => {
  const typed = (input ?? {}) as ImageGenerateInput
  const prompt = typeof typed.prompt === "string" ? typed.prompt.trim() : ""
  if (!prompt) {
    throw new Error("prompt is required for image.generate")
  }

  const aspectRatio = typed.aspectRatio ?? "landscape"
  const quality = typed.quality ?? "draft"
  const background = typed.background ?? "auto"
  const outputFormat = typed.outputFormat ?? "png"
  const size = ASPECT_RATIO_TO_SIZE[aspectRatio] ?? "1536x1024"
  const dims = SIZE_DIMENSIONS[size] ?? { width: 1536, height: 1024 }

  const model =
    quality === "final"
      ? (process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1")
      : (process.env.OPENAI_IMAGE_MODEL_DRAFT?.trim() || "gpt-image-1-mini")

  // Enrich prompt with block/page context when available
  const hasContext = typed.blockType || typed.blockId || typed.pageSlug
  const enrichedPrompt = hasContext
    ? enrichPromptWithContext(prompt, {
        session: context.sessionId,
        blockType: typed.blockType,
        blockId: typed.blockId,
        pageSlug: typed.pageSlug,
        style: typed.style,
        background,
      })
    : (typed.style ? `${prompt}. Style: ${typed.style}` : prompt)

  context.onStatusUpdate?.("Generating AI image\u2026")

  // Start progress timer for long-running image generation
  const onProgress = context.onImageProgress
  const stages = [
    { at: 0.00, pct:  0, label: "Understanding prompt\u2026" },
    { at: 0.10, pct: 15, label: "Composing scene\u2026" },
    { at: 0.30, pct: 40, label: "Rendering image\u2026" },
    { at: 0.65, pct: 75, label: "Finalizing details\u2026" },
    { at: 0.90, pct: 95, label: "Almost there\u2026" },
  ]
  const estimated = estimatedImageGenMs()
  const startedAt = Date.now()
  let currentStageIdx = 0
  onProgress?.({ percent: 0, stage: stages[0].label })
  const progressTimer = onProgress ? setInterval(() => {
    const elapsed = Date.now() - startedAt
    const progress = Math.min(elapsed / estimated, 1)
    while (currentStageIdx < stages.length - 1 && progress >= stages[currentStageIdx + 1].at) {
      currentStageIdx++
    }
    const cur = stages[currentStageIdx]
    const next = stages[currentStageIdx + 1] ?? { at: 1, pct: 95 }
    const stageProgress = (progress - cur.at) / (next.at - cur.at)
    const pct = Math.min(Math.round(cur.pct + stageProgress * (next.pct - cur.pct)), 95)
    onProgress({ percent: pct, stage: cur.label })
  }, 500) : null

  const provider = (process.env.IMAGE_GEN_PROVIDER?.trim().toLowerCase()) || "openai"

  const genStart = Date.now()
  let result: Awaited<ReturnType<typeof generateVariationImageWithOpenAI>> = null
  try {
    result = provider === "gemini"
      ? await generateVariationImageWithGemini({
          prompt: enrichedPrompt,
          altText: prompt,
          aspectRatio,
          quality,
          background,
          signal,
        })
      : await generateVariationImageWithOpenAI({
          prompt: enrichedPrompt,
          altText: prompt,
          size,
          model,
          background,
          outputFormat,
          signal,
        })
  } finally {
    recordImageGenDuration(Date.now() - genStart)
    if (progressTimer) clearInterval(progressTimer)
  }
  onProgress?.({ percent: 100, stage: "Done" })

  if (!result) {
    throw new Error("Image generation failed — no image was returned")
  }

  return {
    imageUrl: result.url,
    alt: result.alt,
    width: dims.width,
    height: dims.height
  }
}
