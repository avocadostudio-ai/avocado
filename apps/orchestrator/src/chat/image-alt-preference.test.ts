import test from "node:test"
import assert from "node:assert/strict"
import { preferredImageAltText } from "./chat-pipeline.js"

test("preferredImageAltText keeps explicit existing alt text", () => {
  const out = preferredImageAltText({
    query: "large yellow lemon with water droplets and a child",
    resolvedAlt: "a close up view of a yellow fruit",
    existingAlt: "großes gelbes Zitronenmotiv mit Wassertropfen und Kind"
  })
  assert.equal(out, "großes gelbes Zitronenmotiv mit Wassertropfen und Kind")
})

test("preferredImageAltText falls back to query when resolved alt is generic mismatch", () => {
  const out = preferredImageAltText({
    query: "große gelbe zitrone wassertropfen und kind",
    resolvedAlt: "a close up view of a yellow fruit"
  })
  assert.equal(out, "Photo of große gelbe zitrone wassertropfen und kind")
})

test("preferredImageAltText keeps resolved alt when it matches query keywords", () => {
  const out = preferredImageAltText({
    query: "fresh lemons on wooden table",
    resolvedAlt: "three lemons are sitting on a wooden table"
  })
  assert.equal(out, "three lemons are sitting on a wooden table")
})
