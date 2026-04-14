import test from "node:test"
import assert from "node:assert/strict"
import { detectImageSourceAmbiguity } from "./intent-helpers.js"

const BOTH_SOURCES = { hasUnsplash: true, hasGenAI: true }
const UNSPLASH_ONLY = { hasUnsplash: true, hasGenAI: false }
const GENAI_ONLY = { hasUnsplash: false, hasGenAI: true }

test("detectImageSourceAmbiguity: generic image intent + both sources → true", () => {
  assert.equal(detectImageSourceAmbiguity("add an image to the hero", BOTH_SOURCES), true)
  assert.equal(detectImageSourceAmbiguity("change the photo", BOTH_SOURCES), true)
  assert.equal(detectImageSourceAmbiguity("set a hero image for this page", BOTH_SOURCES), true)
  assert.equal(detectImageSourceAmbiguity("find a picture of avocados", BOTH_SOURCES), true)
  assert.equal(detectImageSourceAmbiguity("replace the image", BOTH_SOURCES), true)
})

test("detectImageSourceAmbiguity: explicit Unsplash → false", () => {
  assert.equal(detectImageSourceAmbiguity("find an unsplash image of avocados", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("add a stock photo of a sunset", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("use a royalty-free photo", BOTH_SOURCES), false)
})

test("detectImageSourceAmbiguity: explicit AI → false", () => {
  assert.equal(detectImageSourceAmbiguity("generate an image of spring avocados", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("create an AI image of a mountain", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("make an ai-generated hero image", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("use dall-e to make a logo", BOTH_SOURCES), false)
})

test("detectImageSourceAmbiguity: only one source configured → false", () => {
  assert.equal(detectImageSourceAmbiguity("add an image", UNSPLASH_ONLY), false)
  assert.equal(detectImageSourceAmbiguity("add an image", GENAI_ONLY), false)
})

test("detectImageSourceAmbiguity: non-image prompts → false", () => {
  assert.equal(detectImageSourceAmbiguity("change the headline to Hello", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("add a CTA block", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("", BOTH_SOURCES), false)
})

test("detectImageSourceAmbiguity: Google Drive mentions → treated as explicit source, skip ambiguity", () => {
  assert.equal(detectImageSourceAmbiguity("use an image from our drive", BOTH_SOURCES), false)
  assert.equal(detectImageSourceAmbiguity("add a brand asset image", BOTH_SOURCES), false)
})
