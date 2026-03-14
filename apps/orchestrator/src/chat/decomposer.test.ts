import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isMultiStepCandidate, decomposeRequest } from "./decomposer.js"
import type { PageDoc } from "@ai-site-editor/shared"

describe("isMultiStepCandidate", () => {
  it("returns true for plural pages + creation verb", () => {
    assert.ok(isMultiStepCandidate("add 3 new pages for each card item and link CTAs to them"))
    assert.ok(isMultiStepCandidate("create pages for developers, marketers, and founders"))
    assert.ok(isMultiStepCandidate("generate 5 pages with content"))
  })

  it("returns true for 'for each' patterns", () => {
    assert.ok(isMultiStepCandidate("create a page for each card"))
    assert.ok(isMultiStepCandidate("add a page for every product"))
    assert.ok(isMultiStepCandidate("build content for all items"))
  })

  it("returns true for counted pages", () => {
    assert.ok(isMultiStepCandidate("create three new pages"))
    assert.ok(isMultiStepCandidate("add 4 pages about our products"))
  })

  it("returns true for multi-action patterns", () => {
    assert.ok(isMultiStepCandidate("create new pages and then update the card links"))
  })

  it("returns false for simple edits", () => {
    assert.ok(!isMultiStepCandidate("change the heading to Hello World"))
    assert.ok(!isMultiStepCandidate("update the hero image"))
    assert.ok(!isMultiStepCandidate("add a testimonials section"))
    assert.ok(!isMultiStepCandidate("remove the FAQ block"))
  })

  it("returns false for single page creation", () => {
    assert.ok(!isMultiStepCandidate("create a new about page"))
  })
})

describe("decomposeRequest", () => {
  const mockPage: PageDoc = {
    id: "test-page-1",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      { id: "b1", type: "Hero", props: { heading: "Welcome" } },
      {
        id: "b2",
        type: "CardGrid",
        props: {
          cards: [
            { title: "Avocado Oil", description: "Pure oil", ctaText: "Learn more", ctaHref: "#" },
            { title: "Cold Pressed", description: "Fresh pressed", ctaText: "Learn more", ctaHref: "#" }
          ]
        }
      }
    ]
  }

  it("returns parsed steps from mocked LLM response", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  steps: [
                    "Create a new page /avocado-oil about Avocado Oil with a Hero and RichText block",
                    "Create a new page /cold-pressed about Cold Pressed with a Hero and RichText block",
                    "Update CardGrid CTAs: set Avocado Oil CTA href to /avocado-oil, Cold Pressed CTA href to /cold-pressed"
                  ],
                  labels: [
                    "Create /avocado-oil page",
                    "Create /cold-pressed page",
                    "Link card CTAs"
                  ]
                })
              }
            }]
          })
        }
      }
    }

    const result = await decomposeRequest({
      message: "add new pages for each card item and link CTAs to them",
      currentPage: mockPage,
      slug: "/",
      model: "gpt-4o-mini",
      client: mockClient
    })

    assert.equal(result.steps.length, 3)
    assert.equal(result.labels.length, 3)
    assert.ok(result.steps[0].includes("avocado-oil"))
    assert.ok(result.labels[2].includes("Link"))
  })

  it("falls back to original message on empty LLM response", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "{}" } }]
          })
        }
      }
    }

    const result = await decomposeRequest({
      message: "change heading to Hello",
      currentPage: mockPage,
      slug: "/",
      model: "gpt-4o-mini",
      client: mockClient
    })

    assert.equal(result.steps.length, 1)
    assert.equal(result.steps[0], "change heading to Hello")
  })

  it("falls back on malformed JSON", async () => {
    const mockClient = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: "not json" } }]
          })
        }
      }
    }

    const result = await decomposeRequest({
      message: "create pages for each card",
      currentPage: mockPage,
      slug: "/",
      model: "gpt-4o-mini",
      client: mockClient
    })

    assert.equal(result.steps.length, 1)
    assert.equal(result.steps[0], "create pages for each card")
  })
})
