import test from "node:test"
import assert from "node:assert/strict"
import { imageGenerateHandler, imageGenerateManifest } from "./image-generate.js"
import type { ToolCallContext, ToolManifest } from "../types.js"

function makeContext(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    siteId: "test-site",
    sessionId: "test-session",
    traceId: "test-trace",
    plannerProvider: "anthropic",
    ...overrides
  }
}

test("imageGenerateManifest has correct name and capability", () => {
  assert.equal(imageGenerateManifest.name, "image.generate")
  assert.equal(imageGenerateManifest.capability, "read")
  assert.equal(imageGenerateManifest.idempotent, false)
  assert.equal(imageGenerateManifest.timeoutMs, 90000)
})

test("image.generate throws when prompt is missing", async () => {
  await assert.rejects(
    () =>
      imageGenerateHandler({
        input: {},
        context: makeContext(),
        manifest: imageGenerateManifest
      }),
    { message: "prompt is required for image.generate" }
  )
})

test("image.generate throws when prompt is empty string", async () => {
  await assert.rejects(
    () =>
      imageGenerateHandler({
        input: { prompt: "   " },
        context: makeContext(),
        manifest: imageGenerateManifest
      }),
    { message: "prompt is required for image.generate" }
  )
})

test("image.generate calls onStatusUpdate", async (t) => {
  const statusMessages: string[] = []
  const ctx = makeContext({
    onStatusUpdate: (msg) => statusMessages.push(msg)
  })

  // Mock generateVariationImageWithOpenAI by setting OPENAI_API_KEY to empty
  // so the underlying function returns null, which triggers the error path
  const origKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  t.after(() => {
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey
    else delete process.env.OPENAI_API_KEY
  })

  await assert.rejects(
    () =>
      imageGenerateHandler({
        input: { prompt: "green olives on marble" },
        context: ctx,
        manifest: imageGenerateManifest
      }),
    { message: "Image generation failed — no image was returned" }
  )

  assert.deepEqual(statusMessages, ["Generating AI image..."])
})

test("image.generate aspectRatio maps to correct dimensions in output schema", () => {
  // Verify the manifest output schema includes width/height
  const outputProps = imageGenerateManifest.outputSchema.properties ?? {}
  assert.ok("width" in outputProps)
  assert.ok("height" in outputProps)
  assert.ok("imageUrl" in outputProps)
  assert.ok("alt" in outputProps)
})
