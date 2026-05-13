import test from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@avocadostudio-ai/shared"
import { isVisionAltGenerationRequest } from "./chat-pipeline.js"

const pageWithHeroImage: PageDoc = {
  id: "p",
  slug: "/",
  title: "Home",
  updatedAt: new Date().toISOString(),
  blocks: [
    {
      id: "b_hero_1",
      type: "Hero",
      props: {
        heading: "Welcome",
        imageUrl: "https://images.unsplash.com/photo-1234",
        imageAlt: "old alt"
      }
    }
  ]
}

const pageWithoutImage: PageDoc = {
  ...pageWithHeroImage,
  blocks: [{ id: "b_hero_1", type: "Hero", props: { heading: "Welcome" } }]
}

test("isVisionAltGenerationRequest: true for 'Generate alt text' on imageAlt with image present", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Generate alt text",
      activeEditablePath: "imageAlt",
      activeBlockId: "b_hero_1",
      currentPage: pageWithHeroImage
    }),
    true
  )
})

test("isVisionAltGenerationRequest: true for 'Improve accessibility'", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Improve accessibility",
      activeEditablePath: "imageAlt",
      activeBlockId: "b_hero_1",
      currentPage: pageWithHeroImage
    }),
    true
  )
})

test("isVisionAltGenerationRequest: true for 'Make more descriptive'", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Make more descriptive",
      activeEditablePath: "imageAlt",
      activeBlockId: "b_hero_1",
      currentPage: pageWithHeroImage
    }),
    true
  )
})

test("isVisionAltGenerationRequest: true for nested 'cards[0].imageAlt' path", () => {
  const page: PageDoc = {
    ...pageWithHeroImage,
    blocks: [
      {
        id: "b_cards_1",
        type: "CardGrid",
        props: {
          cards: [{ title: "x", imageUrl: "https://example.com/c.jpg", imageAlt: "" }]
        }
      }
    ]
  }
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Generate alt text",
      activeEditablePath: "cards[0].imageAlt",
      activeBlockId: "b_cards_1",
      currentPage: page
    }),
    true
  )
})

test("isVisionAltGenerationRequest: false when no companion image URL", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Generate alt text",
      activeEditablePath: "imageAlt",
      activeBlockId: "b_hero_1",
      currentPage: pageWithoutImage
    }),
    false
  )
})

test("isVisionAltGenerationRequest: false for non-alt fields", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Generate alt text",
      activeEditablePath: "heading",
      activeBlockId: "b_hero_1",
      currentPage: pageWithHeroImage
    }),
    false
  )
})

test("isVisionAltGenerationRequest: false for unrelated alt-field message", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "change the heading",
      activeEditablePath: "imageAlt",
      activeBlockId: "b_hero_1",
      currentPage: pageWithHeroImage
    }),
    false
  )
})

test("isVisionAltGenerationRequest: false without active block", () => {
  assert.equal(
    isVisionAltGenerationRequest({
      message: "Generate alt text",
      activeEditablePath: "imageAlt",
      activeBlockId: undefined,
      currentPage: pageWithHeroImage
    }),
    false
  )
})
