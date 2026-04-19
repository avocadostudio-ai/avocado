import test from "node:test"
import assert from "node:assert/strict"
import { futureToPastTense, pastToFutureTense } from "./chat-pipeline-ui.js"

test("futureToPastTense: 'Will add' → 'Added'", () => {
  assert.equal(
    futureToPastTense("Will add SEO metadata to the Oranges page to improve search visibility."),
    "Added SEO metadata to the Oranges page to improve search visibility."
  )
})

test("futureToPastTense: 'Will update' → 'Updated'", () => {
  assert.equal(
    futureToPastTense("Will update the Hero heading and subheading."),
    "Updated the Hero heading and subheading."
  )
})

test("futureToPastTense: 'Will remove' → 'Removed'", () => {
  assert.equal(
    futureToPastTense("Will remove the FAQ section from the page."),
    "Removed the FAQ section from the page."
  )
})

test("futureToPastTense: bare imperative 'Add the' → 'Added the'", () => {
  assert.equal(
    futureToPastTense("Add the FeatureGrid block below the Hero."),
    "Added the FeatureGrid block below the Hero."
  )
})

test("futureToPastTense: bare imperative 'Update the' → 'Updated the'", () => {
  assert.equal(
    futureToPastTense("Update the Hero image and heading."),
    "Updated the Hero image and heading."
  )
})

test("futureToPastTense: 'Will replace' → 'Replaced'", () => {
  assert.equal(
    futureToPastTense("Will replace the Hero image with a new one."),
    "Replaced the Hero image with a new one."
  )
})

test("futureToPastTense: 'Will create' → 'Created'", () => {
  assert.equal(
    futureToPastTense("Will create a new About page."),
    "Created a new About page."
  )
})

test("futureToPastTense: 'Will set' → 'Set'", () => {
  assert.equal(
    futureToPastTense("Will set the meta description."),
    "Set the meta description."
  )
})

test("futureToPastTense: already past tense is unchanged", () => {
  assert.equal(
    futureToPastTense("Updated the hero heading."),
    "Updated the hero heading."
  )
})

test("futureToPastTense: 'Will generate' → 'Generated'", () => {
  assert.equal(
    futureToPastTense("Will generate an image for the Hero section."),
    "Generated an image for the Hero section."
  )
})

test("futureToPastTense: generic 'will emphasize' → 'emphasized'", () => {
  assert.equal(
    futureToPastTense("The title will emphasize the brand story."),
    "The title emphasized the brand story."
  )
})

test("futureToPastTense: generic 'will highlight' → 'highlighted'", () => {
  assert.equal(
    futureToPastTense("the description will highlight the unique value"),
    "the description highlighted the unique value"
  )
})

test("futureToPastTense: multiple 'will' in one sentence", () => {
  assert.equal(
    futureToPastTense("The title will emphasize sustainability, while the description will highlight the value."),
    "The title emphasized sustainability, while the description highlighted the value."
  )
})

// ---------------------------------------------------------------------------
// pastToFutureTense — inverse used on the approval gate
// ---------------------------------------------------------------------------

test("pastToFutureTense: 'Added …' → 'Will add …'", () => {
  assert.equal(
    pastToFutureTense("Added FeatureGrid with 4 spring benefits."),
    "Will add FeatureGrid with 4 spring benefits."
  )
})

test("pastToFutureTense: 'Created …' → 'Will create …'", () => {
  assert.equal(
    pastToFutureTense("Created Spring Avocado campaign page."),
    "Will create Spring Avocado campaign page."
  )
})

test("pastToFutureTense: 'Set …' at sentence start → 'Will set …'", () => {
  assert.equal(
    pastToFutureTense("Set page metadata: title 'Spring Avocado Season'."),
    "Will set page metadata: title 'Spring Avocado Season'."
  )
})

test("pastToFutureTense: irregular 'Rewrote' → 'Will rewrite'", () => {
  assert.equal(
    pastToFutureTense("Rewrote the hero heading."),
    "Will rewrite the hero heading."
  )
})

test("pastToFutureTense: handles multi-sentence text", () => {
  assert.equal(
    pastToFutureTense("Created a new About page. Added Hero block."),
    "Will create a new About page. Will add Hero block."
  )
})

test("pastToFutureTense: already future-tense lines are unchanged", () => {
  assert.equal(
    pastToFutureTense("Will find an image."),
    "Will find an image."
  )
})

test("pastToFutureTense: does not touch past tense mid-sentence", () => {
  // "updated" here is an adjective/participle, not the sentence verb.
  assert.equal(
    pastToFutureTense("The config was updated to 5."),
    "The config was updated to 5."
  )
})

test("pastToFutureTense: converts past tense inside bold marker", () => {
  // Planner output sometimes starts change_log entries with **Bold**.
  assert.equal(
    pastToFutureTense("**Added** Hero block."),
    "**Will add** Hero block."
  )
})

test("pastToFutureTense: round-trips with futureToPastTense for 'Added'", () => {
  const original = "Added FeatureGrid with 4 benefits."
  const future = pastToFutureTense(original)
  assert.equal(future, "Will add FeatureGrid with 4 benefits.")
  assert.equal(futureToPastTense(future), original)
})
