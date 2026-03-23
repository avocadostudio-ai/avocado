import { generateVariationImageWithOpenAI, generateVariationImageWithGemini, recordImageGenDuration, estimatedImageGenMs } from "../../image/image-helpers.js"
import type { ToolManifest, ToolHandler } from "../types.js"

type ImageGenerateInput = {
  prompt: string
  aspectRatio?: "landscape" | "square" | "portrait"
  quality?: "draft" | "final"
  style?: string
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
      style: { type: "string", description: "Optional style guidance (e.g. 'photorealistic', 'illustration')" }
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

export const imageGenerateHandler: ToolHandler = async ({ input, context }) => {
  const typed = (input ?? {}) as ImageGenerateInput
  const prompt = typeof typed.prompt === "string" ? typed.prompt.trim() : ""
  if (!prompt) {
    throw new Error("prompt is required for image.generate")
  }

  const aspectRatio = typed.aspectRatio ?? "landscape"
  const quality = typed.quality ?? "draft"
  const size = ASPECT_RATIO_TO_SIZE[aspectRatio] ?? "1536x1024"
  const dims = SIZE_DIMENSIONS[size] ?? { width: 1536, height: 1024 }

  const model =
    quality === "final"
      ? (process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1")
      : (process.env.OPENAI_IMAGE_MODEL_DRAFT?.trim() || "gpt-image-1-mini")

  const fullPrompt = typed.style ? `${prompt}. Style: ${typed.style}` : prompt

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
  const result = provider === "gemini"
    ? await generateVariationImageWithGemini({
        prompt: fullPrompt,
        altText: prompt,
        aspectRatio,
        quality
      })
    : await generateVariationImageWithOpenAI({
        prompt: fullPrompt,
        altText: prompt,
        size,
        model
      })
  recordImageGenDuration(Date.now() - genStart)
  if (progressTimer) clearInterval(progressTimer)
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
