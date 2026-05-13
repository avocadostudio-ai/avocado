/**
 * Agent tests — unit tests for tool definitions and context builder.
 * Does NOT call the real Anthropic API.
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { PageDoc } from "@avocadostudio-ai/shared"
import { createAgentTools } from "./agent-tools.js"
import { buildAgentSystemPrompt, buildContextMessage } from "./agent-context.js"
import {
  seedSession,
  getDraft,
  resetSessionState,
  makeHomePage,
} from "../test/fixtures.js"

const TEST_SESSION = "__agent_test__"

function seed() {
  seedSession(TEST_SESSION, makeHomePage())
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe("createAgentTools", () => {
  beforeEach(() => {
    resetSessionState(TEST_SESSION)
    seed()
  })

  it("returns compound + atomic + read-only tools", () => {
    const tools = createAgentTools(TEST_SESSION)
    const names = tools.map((t) => t.definition.name)

    // Compound
    assert.ok(names.includes("edit_page"))
    assert.ok(names.includes("batch_update_props"))
    assert.ok(names.includes("add_block_with_content"))

    // Atomic
    assert.ok(names.includes("remove_block"))
    assert.ok(names.includes("move_block"))
    assert.ok(names.includes("create_page"))

    // Read-only
    assert.ok(names.includes("get_page"))
    assert.ok(names.includes("list_pages"))
    assert.ok(names.includes("get_block_schema"))
  })

  it("batch_update_props applies changes to session state", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "batch_update_props")!

    const result = await tool.handler({
      pageSlug: "/",
      blockId: "b_hero",
      patch: { heading: "Updated Heading" },
    })

    assert.ok(!result.isError, `Expected success, got: ${result.result}`)
    const parsed = JSON.parse(result.result)
    assert.equal(parsed.status, "applied")

    const page = getDraft(TEST_SESSION, "/")
    const hero = page?.blocks.find((b) => b.id === "b_hero")
    assert.equal(hero?.props.heading, "Updated Heading")
  })

  it("batch_update_props returns error for non-existent block", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "batch_update_props")!

    const result = await tool.handler({
      pageSlug: "/",
      blockId: "b_nonexistent",
      patch: { heading: "Nope" },
    })

    assert.ok(result.isError)
    assert.ok(result.result.includes("Error"))
  })

  it("add_block_with_content creates a new block", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "add_block_with_content")!

    const result = await tool.handler({
      pageSlug: "/",
      blockType: "CTA",
      props: { title: "Get Started", ctaText: "Sign Up" },
    })

    assert.ok(!result.isError, `Expected success, got: ${result.result}`)

    const parsed = JSON.parse(result.result)
    assert.equal(parsed.status, "applied")
    assert.equal(parsed.appliedCount, 1)
  })

  it("add_block_with_content respects afterBlockId", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "add_block_with_content")!

    const pageBefore = getDraft(TEST_SESSION, "/")!
    const firstBlockId = pageBefore.blocks[0].id

    await tool.handler({
      pageSlug: "/",
      blockType: "CTA",
      props: { heading: "New CTA" },
      afterBlockId: firstBlockId,
    })

    const page = getDraft(TEST_SESSION, "/")!
    const cta = page.blocks.find((b) => b.type === "CTA")!
    const ctaIndex = page.blocks.indexOf(cta)
    assert.equal(ctaIndex, 1, "CTA should be at index 1 (after first block)")
  })

  it("edit_page applies multiple operations atomically", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "edit_page")!

    const pageBefore = getDraft(TEST_SESSION, "/")!
    const heroId = pageBefore.blocks.find((b) => b.type === "Hero")?.id

    const result = await tool.handler({
      pageSlug: "/",
      operations: [
        { op: "update_props", blockId: heroId, patch: { heading: "Multi-step Edit" } },
      ],
    })

    assert.ok(!result.isError, `Expected success, got: ${result.result}`)
    const page = getDraft(TEST_SESSION, "/")!
    const hero = page.blocks.find((b) => b.type === "Hero")
    assert.equal(hero?.props.heading, "Multi-step Edit")
  })

  it("remove_block deletes a block", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const addTool = tools.find((t) => t.definition.name === "add_block_with_content")!
    const removeTool = tools.find((t) => t.definition.name === "remove_block")!

    // Add a block first
    await addTool.handler({ pageSlug: "/", blockType: "CTA", props: { heading: "Temp" } })
    const pageAfterAdd = getDraft(TEST_SESSION, "/")!
    const cta = pageAfterAdd.blocks.find((b) => b.type === "CTA")!

    // Remove it
    const result = await removeTool.handler({ pageSlug: "/", blockId: cta.id })
    assert.ok(!result.isError)

    const pageAfterRemove = getDraft(TEST_SESSION, "/")!
    assert.ok(!pageAfterRemove.blocks.find((b) => b.id === cta.id))
  })

  it("get_page returns page content", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "get_page")!

    const result = await tool.handler({ pageSlug: "/" })
    assert.ok(!result.isError)

    const parsed = JSON.parse(result.result)
    assert.equal(parsed.slug, "/")
    assert.ok(Array.isArray(parsed.blocks))
    assert.ok(parsed.blocks.length > 0)
  })

  it("get_page returns error for missing page", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "get_page")!

    const result = await tool.handler({ pageSlug: "/nonexistent" })
    assert.ok(result.isError)
  })

  it("list_pages returns all pages", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "list_pages")!

    const result = await tool.handler({})
    assert.ok(!result.isError)

    const parsed = JSON.parse(result.result)
    assert.ok(Array.isArray(parsed))
    assert.ok(parsed.length >= 1)
    assert.ok(parsed.some((p: { slug: string }) => p.slug === "/"))
  })

  it("get_block_schema returns default props", async () => {
    const tools = createAgentTools(TEST_SESSION)
    const tool = tools.find((t) => t.definition.name === "get_block_schema")!

    const result = await tool.handler({ blockType: "Hero" })
    assert.ok(!result.isError)

    const parsed = JSON.parse(result.result)
    assert.equal(parsed.type, "Hero")
    assert.ok(parsed.defaultProps)
  })
})

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

describe("buildAgentSystemPrompt", () => {
  it("includes role and editing guidelines", () => {
    const prompt = buildAgentSystemPrompt()
    assert.ok(prompt.includes("website editor"))
    assert.ok(prompt.includes("Editing Guidelines"))
  })

  it("includes site purpose when provided", () => {
    const prompt = buildAgentSystemPrompt({ sitePurpose: "B2B SaaS landing page" })
    assert.ok(prompt.includes("B2B SaaS landing page"))
  })

  it("includes locale instruction for non-English", () => {
    const prompt = buildAgentSystemPrompt({ locale: "de" })
    assert.ok(prompt.includes("de"))
  })
})

describe("buildContextMessage", () => {
  beforeEach(() => {
    resetSessionState(TEST_SESSION)
    seed()
  })

  it("includes page overview and block list", () => {
    const msg = buildContextMessage(TEST_SESSION, { slug: "/" })
    assert.ok(msg.includes("Current page:"))
    assert.ok(msg.includes("Blocks"))
    assert.ok(msg.includes("Hero"))
  })

  it("includes selected block details when activeBlockId provided", () => {
    const page = getDraft(TEST_SESSION, "/")!
    const heroId = page.blocks.find((b) => b.type === "Hero")?.id ?? ""

    const msg = buildContextMessage(TEST_SESSION, { slug: "/", activeBlockId: heroId })
    assert.ok(msg.includes("Selected block:"))
    assert.ok(msg.includes("Full props:"))
  })

  it("returns error message for missing page", () => {
    const msg = buildContextMessage(TEST_SESSION, { slug: "/nope" })
    assert.ok(msg.includes("not found"))
  })
})
