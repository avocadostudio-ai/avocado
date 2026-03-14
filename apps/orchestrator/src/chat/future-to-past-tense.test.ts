import test from "node:test"
import assert from "node:assert/strict"
import { futureToPastTense } from "./chat-pipeline-ui.js"

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
