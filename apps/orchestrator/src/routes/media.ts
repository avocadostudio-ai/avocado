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
