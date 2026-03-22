import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import OpenAI from "openai"
import { toFile } from "openai/uploads"
import { toErrorDetail } from "../ops/ops-engine.js"
import { openAIChatOptionsForModel } from "../chat/planner.js"
import type { RouteContext } from "./route-context.js"

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

function extensionFromImageMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    default:
      return "png"
  }
}

async function readMultipartImageFile(request: FastifyRequest, reply: FastifyReply) {
  const inputFile = await request.file()
  if (!inputFile) return { ok: false as const, response: reply.code(400).send({ error: "image file is required" }) }
  if (inputFile.fieldname !== "image") return { ok: false as const, response: reply.code(400).send({ error: "image field must be named 'image'" }) }
  if (!allowedImageAnalysisMimeTypes.has(inputFile.mimetype)) {
    return { ok: false as const, response: reply.code(415).send({ error: `unsupported image type: ${inputFile.mimetype}` }) }
  }

  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of inputFile.file) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += data.byteLength
    if (totalBytes > 10 * 1024 * 1024) {
      return { ok: false as const, response: reply.code(413).send({ error: "image file is too large (max 10MB)" }) }
    }
    chunks.push(data)
  }
  if (totalBytes === 0) return { ok: false as const, response: reply.code(400).send({ error: "image file is empty" }) }
  return { ok: true as const, inputFile, totalBytes, buffer: Buffer.concat(chunks) }
}

export async function mediaRoutes(app: FastifyInstance, ctx: RouteContext) {
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

    const parsed = await readMultipartImageFile(request, reply)
    if (!parsed.ok) return parsed.response
    const { inputFile, totalBytes, buffer } = parsed

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const model = process.env.OPENAI_VISION_MODEL?.trim() || "gpt-4o"
    const base64 = buffer.toString("base64")
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

  // Contentful assets proxy for the editor image picker
  app.get("/contentful/assets", async (request, reply) => {
    const spaceId = process.env.CONTENTFUL_SPACE_ID?.trim()
    const token = process.env.CONTENTFUL_DELIVERY_TOKEN?.trim()
    if (!spaceId || !token) {
      return reply.code(404).send({ error: "Contentful not configured" })
    }
    const env = process.env.CONTENTFUL_ENVIRONMENT?.trim() || "master"
    const query = request.query as { q?: string; limit?: string; page?: string }
    const q = typeof query.q === "string" ? query.q.trim() : ""
    const limit = Math.min(20, Math.max(1, Number(query.limit) || 20))
    const page = Math.max(1, Math.trunc(Number(query.page) || 1))
    const skip = (page - 1) * limit

    try {
      const params = new URLSearchParams({
        access_token: token,
        mimetype_group: "image",
        limit: String(limit),
        skip: String(skip),
        order: "-sys.createdAt"
      })
      if (q) params.set("query", q)

      const endpoint = `https://cdn.contentful.com/spaces/${spaceId}/environments/${env}/assets?${params}`
      const res = await fetch(endpoint)
      if (!res.ok) return { items: [], totalPages: 0 }
      const payload = (await res.json()) as {
        total?: number
        items?: Array<{
          sys?: { id?: string }
          fields?: {
            title?: string
            description?: string
            file?: { url?: string; contentType?: string }
          }
        }>
      }
      const items = (payload.items ?? [])
        .filter((a) => a.sys?.id && a.fields?.file?.url)
        .map((a) => {
          const fileUrl = `https:${a.fields!.file!.url!}`
          return {
            id: a.sys!.id!,
            name: a.fields?.title ?? "",
            thumbUrl: `${fileUrl}?w=300&h=200&fit=thumb`,
            imageUrl: `${fileUrl}?w=1600&q=80`,
            alt: a.fields?.description ?? a.fields?.title ?? ""
          }
        })
      const total = payload.total ?? 0
      const totalPages = Math.ceil(total / limit)
      return { items, totalPages }
    } catch {
      return { items: [], totalPages: 0 }
    }
  })

  // Unsplash search proxy for the editor image picker
  app.get("/unsplash/search", async (request, reply) => {
    const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim()
    if (!accessKey) {
      return reply.code(404).send({ error: "Unsplash not configured" })
    }
    const query = request.query as { q?: string; limit?: string; page?: string }
    const q = typeof query.q === "string" ? query.q.trim() : ""
    if (!q) return { items: [], totalPages: 0 }
    const limit = Math.min(20, Math.max(1, Number(query.limit) || 8))
    const page = Math.max(1, Math.trunc(Number(query.page) || 1))

    try {
      const endpoint = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&orientation=landscape&per_page=${limit}&page=${page}&content_filter=high`
      const res = await fetch(endpoint, {
        headers: { Authorization: `Client-ID ${accessKey}`, "Accept-Version": "v1" }
      })
      if (!res.ok) return { items: [], totalPages: 0 }
      const payload = (await res.json()) as { total_pages?: number; results?: Array<{ id?: string; urls?: { regular?: string; small?: string }; alt_description?: string; description?: string; user?: { name?: string } }> }
      const items = (payload.results ?? []).map((r) => {
        const imageUrl = typeof r.urls?.regular === "string" ? r.urls.regular : ""
        const thumbUrl = typeof r.urls?.small === "string" ? r.urls.small : imageUrl
        return {
          id: r.id ?? "",
          imageUrl,
          thumbUrl,
          alt: typeof r.alt_description === "string" ? r.alt_description : typeof r.description === "string" ? r.description : "",
          author: r.user?.name ?? "Unsplash"
        }
      }).filter((item) => item.id && item.imageUrl)
      return { items, totalPages: payload.total_pages ?? 0 }
    } catch {
      return { items: [], totalPages: 0 }
    }
  })

  // Image generation proxy for the editor image picker
  app.post("/image/generate", async (request, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "OPENAI_API_KEY is not configured" })
    }
    const body = (request.body ?? {}) as { prompt?: string; aspectRatio?: string }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
    if (!prompt) return reply.code(400).send({ error: "prompt is required" })

    const aspectSizes: Record<string, string> = { landscape: "1536x1024", square: "1024x1024", portrait: "1024x1536" }
    const size = aspectSizes[body.aspectRatio ?? "landscape"] ?? "1536x1024"
    const model = process.env.OPENAI_IMAGE_MODEL_DRAFT?.trim() || "gpt-image-1-mini"

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    try {
      const result = await client.images.generate({ model, prompt, size: size as "1536x1024" })
      const image = result.data?.[0]
      let bytes: Buffer | null = null
      if (typeof image?.b64_json === "string" && image.b64_json.length > 0) {
        bytes = Buffer.from(image.b64_json, "base64")
      } else if (typeof image?.url === "string" && image.url.length > 0) {
        const fetched = await fetch(image.url)
        if (fetched.ok) bytes = Buffer.from(await fetched.arrayBuffer())
      }
      if (!bytes || bytes.byteLength === 0) {
        return reply.code(502).send({ error: "Image generation returned no data" })
      }

      const fileName = `gen_${Date.now()}_${randomUUID().slice(0, 8)}.png`
      await mkdir(ctx.generatedImageDir, { recursive: true })
      await writeFile(resolve(ctx.generatedImageDir, fileName), bytes)

      return {
        url: `${ctx.orchestratorPublicOrigin}/generated-images/${fileName}`,
        alt: prompt.slice(0, 200)
      }
    } catch (error) {
      return reply.code(502).send({ error: "Image generation failed", detail: toErrorDetail(error) })
    }
  })

  app.post("/image/upload", async (request, reply) => {
    const parsed = await readMultipartImageFile(request, reply)
    if (!parsed.ok) return parsed.response
    const { inputFile, totalBytes, buffer } = parsed

    const ext = extensionFromImageMimeType(inputFile.mimetype)
    const fileName = `upload_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`
    const targetPath = resolve(ctx.generatedImageDir, fileName)

    try {
      await mkdir(ctx.generatedImageDir, { recursive: true })
      await writeFile(targetPath, buffer)
      return {
        url: `${ctx.orchestratorPublicOrigin}/generated-images/${fileName}`,
        bytes: totalBytes,
        mimeType: inputFile.mimetype
      }
    } catch (error) {
      return reply.code(500).send({ error: "image upload failed", detail: toErrorDetail(error) })
    }
  })
}
