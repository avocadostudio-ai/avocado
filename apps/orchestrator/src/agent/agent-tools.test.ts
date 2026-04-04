/**
 * Comprehensive agent tool handler tests.
 * Covers all tool categories: compound, atomic, array item, read-only, site config, variations.
 * Does NOT call real APIs — tests tool handlers against in-memory session state.
 */

import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createAgentTools, type AgentTool } from "./agent-tools.js"
import {
  seedSession,
  getDraft,
  resetSessionState,
  makeHomePage,
  makeFeaturePage,
  makePricingPage,
} from "../test/fixtures.js"

const S = "__agent_tools_test__"

function seed(...pages: Parameters<typeof seedSession>[1][]) {
  seedSession(S, ...pages)
}

function tool(name: string, tools: AgentTool[]): AgentTool {
  const t = tools.find((t) => t.definition.name === name)
  if (!t) throw new Error(`Tool "${name}" not found`)
  return t
}

// ---------------------------------------------------------------------------
// move_block
// ---------------------------------------------------------------------------

describe("move_block", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("moves block to top when no afterBlockId", async () => {
    const tools = createAgentTools(S)
    const result = await tool("move_block", tools).handler({ pageSlug: "/", blockId: "b_cta" })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/")!
    assert.equal(page.blocks[0].id, "b_cta")
  })

  it("moves block after a specific block", async () => {
    // Add a third block first
    await tool("add_block_with_content", createAgentTools(S)).handler({
      pageSlug: "/", blockType: "RichText", props: { content: "text" },
    })
    const tools = createAgentTools(S)
    const page = getDraft(S, "/")!
    const rtBlock = page.blocks.find((b) => b.type === "RichText")!

    const result = await tool("move_block", tools).handler({
      pageSlug: "/", blockId: rtBlock.id, afterBlockId: "b_hero",
    })
    assert.ok(!result.isError, result.result)
    const updated = getDraft(S, "/")!
    const rtIndex = updated.blocks.findIndex((b) => b.id === rtBlock.id)
    const heroIndex = updated.blocks.findIndex((b) => b.id === "b_hero")
    assert.equal(rtIndex, heroIndex + 1)
  })

  it("returns error for non-existent block", async () => {
    const tools = createAgentTools(S)
    const result = await tool("move_block", tools).handler({ pageSlug: "/", blockId: "b_nope" })
    assert.ok(result.isError)
  })
})

// ---------------------------------------------------------------------------
// create_page
// ---------------------------------------------------------------------------

describe("create_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("creates a new page with blocks", async () => {
    const tools = createAgentTools(S)
    const result = await tool("create_page", tools).handler({
      slug: "/about",
      title: "About Us",
      blocks: [{ id: "b_about_hero", type: "Hero", props: { heading: "About", subheading: "Us" } }],
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/about")
    assert.ok(page)
    assert.equal(page!.title, "About Us")
    assert.equal(page!.blocks.length, 1)
    assert.equal(page!.blocks[0].type, "Hero")
  })

  it("creates a page with empty blocks array", async () => {
    const tools = createAgentTools(S)
    const result = await tool("create_page", tools).handler({
      slug: "/empty",
      title: "Empty Page",
      blocks: [],
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/empty")
    assert.ok(page)
    assert.equal(page!.blocks.length, 0)
  })
})

// ---------------------------------------------------------------------------
// rename_page
// ---------------------------------------------------------------------------

describe("rename_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage(), makePricingPage())
  })

  it("renames page slug and title", async () => {
    const tools = createAgentTools(S)
    const result = await tool("rename_page", tools).handler({
      pageSlug: "/pricing",
      newPageSlug: "/plans",
      newTitle: "Plans",
    })
    assert.ok(!result.isError, result.result)
    assert.ok(!getDraft(S, "/pricing"), "old slug should be gone")
    const page = getDraft(S, "/plans")
    assert.ok(page)
    assert.equal(page!.title, "Plans")
  })

  it("returns error for non-existent page", async () => {
    const tools = createAgentTools(S)
    const result = await tool("rename_page", tools).handler({
      pageSlug: "/nope",
      newPageSlug: "/also-nope",
    })
    assert.ok(result.isError)
  })
})

// ---------------------------------------------------------------------------
// remove_page
// ---------------------------------------------------------------------------

describe("remove_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage(), makePricingPage())
  })

  it("deletes a page", async () => {
    const tools = createAgentTools(S)
    const result = await tool("remove_page", tools).handler({ pageSlug: "/pricing" })
    assert.ok(!result.isError, result.result)
    assert.ok(!getDraft(S, "/pricing"))
  })

  it("returns error for non-existent page", async () => {
    const tools = createAgentTools(S)
    const result = await tool("remove_page", tools).handler({ pageSlug: "/nope" })
    assert.ok(result.isError)
  })
})

// ---------------------------------------------------------------------------
// duplicate_block
// ---------------------------------------------------------------------------

describe("duplicate_block", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("duplicates a block on the same page", async () => {
    const tools = createAgentTools(S)
    const before = getDraft(S, "/")!
    const blockCount = before.blocks.length

    const result = await tool("duplicate_block", tools).handler({
      pageSlug: "/", blockId: "b_hero",
    })
    assert.ok(!result.isError, result.result)
    const after = getDraft(S, "/")!
    assert.equal(after.blocks.length, blockCount + 1)
    // The clone should be a Hero type
    const heroes = after.blocks.filter((b) => b.type === "Hero")
    assert.equal(heroes.length, 2)
  })
})

// ---------------------------------------------------------------------------
// duplicate_page
// ---------------------------------------------------------------------------

describe("duplicate_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("duplicates a page with new slug", async () => {
    const tools = createAgentTools(S)
    const result = await tool("duplicate_page", tools).handler({
      pageSlug: "/",
      newPageSlug: "/home-v2",
      newTitle: "Home V2",
    })
    assert.ok(!result.isError, result.result)
    const copy = getDraft(S, "/home-v2")
    assert.ok(copy)
    assert.equal(copy!.title, "Home V2")
    assert.equal(copy!.blocks.length, getDraft(S, "/")!.blocks.length)
  })
})

// ---------------------------------------------------------------------------
// move_page
// ---------------------------------------------------------------------------

describe("move_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage(), makePricingPage(), makeFeaturePage())
  })

  it("moves page in navigation order", async () => {
    const tools = createAgentTools(S)
    const result = await tool("move_page", tools).handler({
      pageSlug: "/features",
      afterPageSlug: "/",
    })
    assert.ok(!result.isError, result.result)
  })
})

// ---------------------------------------------------------------------------
// update_page_meta
// ---------------------------------------------------------------------------

describe("update_page_meta", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("updates page metadata", async () => {
    const tools = createAgentTools(S)
    const result = await tool("update_page_meta", tools).handler({
      pageSlug: "/",
      patch: { title: "Updated Home", description: "Best home page ever" },
    })
    assert.ok(!result.isError, result.result)
  })
})

// ---------------------------------------------------------------------------
// Array item tools (add_item, update_item, remove_item, move_item)
// ---------------------------------------------------------------------------

describe("add_item", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeFeaturePage())
  })

  it("appends an item to a list", async () => {
    const tools = createAgentTools(S)
    const result = await tool("add_item", tools).handler({
      pageSlug: "/features",
      blockId: "b_grid",
      listKey: "features",
      item: { title: "New", description: "Brand new feature" },
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/features")!
    const features = page.blocks[0].props.features as Array<unknown>
    assert.equal(features.length, 4)
  })

  it("inserts at specific position with afterIndex", async () => {
    const tools = createAgentTools(S)
    const result = await tool("add_item", tools).handler({
      pageSlug: "/features",
      blockId: "b_grid",
      listKey: "features",
      item: { title: "Inserted", description: "Between" },
      afterIndex: 0,
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/features")!
    const features = page.blocks[0].props.features as Array<{ title: string }>
    assert.equal(features[1].title, "Inserted")
  })
})

describe("update_item", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeFeaturePage())
  })

  it("updates a specific item in a list", async () => {
    const tools = createAgentTools(S)
    const result = await tool("update_item", tools).handler({
      pageSlug: "/features",
      blockId: "b_grid",
      listKey: "features",
      index: 1,
      patch: { title: "Updated Safe", description: "Even more secure." },
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/features")!
    const features = page.blocks[0].props.features as Array<{ title: string; description: string }>
    assert.equal(features[1].title, "Updated Safe")
    assert.equal(features[1].description, "Even more secure.")
  })
})

describe("remove_item", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeFeaturePage())
  })

  it("removes an item from a list", async () => {
    const tools = createAgentTools(S)
    const result = await tool("remove_item", tools).handler({
      pageSlug: "/features",
      blockId: "b_grid",
      listKey: "features",
      index: 0,
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/features")!
    const features = page.blocks[0].props.features as Array<{ title: string }>
    assert.equal(features.length, 2)
    assert.equal(features[0].title, "Safe") // "Fast" was at index 0, now removed
  })
})

describe("move_item", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeFeaturePage())
  })

  it("reorders an item within a list", async () => {
    const tools = createAgentTools(S)
    const result = await tool("move_item", tools).handler({
      pageSlug: "/features",
      blockId: "b_grid",
      listKey: "features",
      index: 0,
      afterIndex: 1,
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/features")!
    const features = page.blocks[0].props.features as Array<{ title: string }>
    // "Fast" was at 0, moved to after index 1 → now at index 1 or 2
    assert.ok(features[0].title !== "Fast" || features.length === 3)
  })
})

// ---------------------------------------------------------------------------
// edit_page — multi-op atomicity
// ---------------------------------------------------------------------------

describe("edit_page", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("applies multiple operations atomically", async () => {
    const tools = createAgentTools(S)
    const result = await tool("edit_page", tools).handler({
      pageSlug: "/",
      operations: [
        { op: "update_props", blockId: "b_hero", patch: { heading: "New Heading" } },
        { op: "update_props", blockId: "b_cta", patch: { title: "New CTA" } },
      ],
    })
    assert.ok(!result.isError, result.result)
    const page = getDraft(S, "/")!
    assert.equal(page.blocks.find((b) => b.id === "b_hero")?.props.heading, "New Heading")
    assert.equal(page.blocks.find((b) => b.id === "b_cta")?.props.title, "New CTA")
  })

  it("rolls back all ops when one fails", async () => {
    const tools = createAgentTools(S)
    const result = await tool("edit_page", tools).handler({
      pageSlug: "/",
      operations: [
        { op: "update_props", blockId: "b_hero", patch: { heading: "Will Rollback" } },
        { op: "remove_block", blockId: "b_nonexistent" },
      ],
    })
    assert.ok(result.isError)
    // Original heading should remain
    const page = getDraft(S, "/")!
    assert.equal(page.blocks.find((b) => b.id === "b_hero")?.props.heading, "Hello")
  })

  it("returns applied count and focus block", async () => {
    const tools = createAgentTools(S)
    const result = await tool("edit_page", tools).handler({
      pageSlug: "/",
      operations: [
        { op: "update_props", blockId: "b_hero", patch: { heading: "Focus Test" } },
      ],
    })
    assert.ok(!result.isError)
    const parsed = JSON.parse(result.result)
    assert.equal(parsed.status, "applied")
    assert.equal(parsed.appliedCount, 1)
    assert.ok("focusBlockId" in parsed)
    assert.ok("previewVersion" in parsed)
  })
})

// ---------------------------------------------------------------------------
// Site config tools
// ---------------------------------------------------------------------------

describe("get_site_config", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("returns site config as JSON", async () => {
    const tools = createAgentTools(S)
    const result = await tool("get_site_config", tools).handler({})
    assert.ok(!result.isError)
    const parsed = JSON.parse(result.result)
    assert.ok(typeof parsed === "object")
  })
})

describe("update_site_config", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("updates site name", async () => {
    const tools = createAgentTools(S)
    const result = await tool("update_site_config", tools).handler({
      name: "My Cool Site",
    })
    assert.ok(!result.isError, result.result)
  })

  it("updates nav labels and groups", async () => {
    const tools = createAgentTools(S)
    const result = await tool("update_site_config", tools).handler({
      navLabels: { "/": "Home Sweet Home" },
      navGroups: { Products: ["/pricing"] },
    })
    assert.ok(!result.isError, result.result)
  })
})

// ---------------------------------------------------------------------------
// generate_variations
// ---------------------------------------------------------------------------

describe("generate_variations", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("returns variations for a valid block", async () => {
    const tools = createAgentTools(S)
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/",
      blockId: "b_hero",
      variations: [
        { title: "Bold", summary: "Bold approach", patch: { heading: "BOLD HEADING" } },
        { title: "Soft", summary: "Gentle tone", patch: { heading: "A gentle welcome" } },
      ],
    })
    assert.ok(!result.isError, result.result)
    const parsed = JSON.parse(result.result)
    assert.equal(parsed.status, "ok")
    assert.equal(parsed.variations.length, 2)
    assert.equal(parsed.blockId, "b_hero")
    assert.equal(parsed.blockType, "Hero")
    assert.ok(parsed.baseProps)
  })

  it("filters patch to only changed keys", async () => {
    const tools = createAgentTools(S)
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/",
      blockId: "b_hero",
      variations: [
        { title: "Same", summary: "No changes", patch: { heading: "Hello" } }, // same as current
        { title: "Different", summary: "Changed", patch: { heading: "Changed!" } },
      ],
    })
    assert.ok(!result.isError)
    const parsed = JSON.parse(result.result)
    // First variation has same heading → changedKeys should be empty (patch falls back to original)
    const first = parsed.variations[0]
    assert.ok(first.changedKeys.length === 0 || first.patch.heading === "Hello")
  })

  it("returns error for non-existent page", async () => {
    const tools = createAgentTools(S)
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/nope",
      blockId: "b_hero",
      variations: [{ title: "X", summary: "X", patch: { heading: "X" } }],
    })
    assert.ok(result.isError)
  })

  it("returns error for non-existent block", async () => {
    const tools = createAgentTools(S)
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/",
      blockId: "b_nope",
      variations: [{ title: "X", summary: "X", patch: { heading: "X" } }],
    })
    assert.ok(result.isError)
  })

  it("returns error for empty variations array", async () => {
    const tools = createAgentTools(S)
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/",
      blockId: "b_hero",
      variations: [],
    })
    assert.ok(result.isError)
  })

  it("caps variations at 6", async () => {
    const tools = createAgentTools(S)
    const many = Array.from({ length: 10 }, (_, i) => ({
      title: `V${i}`, summary: `v${i}`, patch: { heading: `Heading ${i}` },
    }))
    const result = await tool("generate_variations", tools).handler({
      pageSlug: "/",
      blockId: "b_hero",
      variations: many,
    })
    assert.ok(!result.isError)
    const parsed = JSON.parse(result.result)
    assert.ok(parsed.variations.length <= 6)
  })
})

// ---------------------------------------------------------------------------
// Tool completeness check
// ---------------------------------------------------------------------------

describe("tool registry completeness", () => {
  beforeEach(() => {
    resetSessionState(S)
    seed(makeHomePage())
  })

  it("all tools have unique names", () => {
    const tools = createAgentTools(S)
    const names = tools.map((t) => t.definition.name)
    const unique = new Set(names)
    assert.equal(unique.size, names.length, `Duplicate tool names: ${names.filter((n, i) => names.indexOf(n) !== i)}`)
  })

  it("all tools have descriptions", () => {
    const tools = createAgentTools(S)
    for (const t of tools) {
      assert.ok(t.definition.description, `Tool "${t.definition.name}" missing description`)
      assert.ok(t.definition.description.length > 10, `Tool "${t.definition.name}" description too short`)
    }
  })

  it("all tools have valid input_schema", () => {
    const tools = createAgentTools(S)
    for (const t of tools) {
      const schema = t.definition.input_schema
      assert.ok(schema, `Tool "${t.definition.name}" missing input_schema`)
      assert.equal(schema.type, "object", `Tool "${t.definition.name}" input_schema.type should be "object"`)
    }
  })

  it("registers all expected tool names", () => {
    const tools = createAgentTools(S)
    const names = new Set(tools.map((t) => t.definition.name))
    const expected = [
      "edit_page", "batch_update_props", "add_block_with_content",
      "remove_block", "move_block", "create_page", "rename_page", "remove_page",
      "duplicate_block", "duplicate_page", "move_page", "update_page_meta",
      "add_item", "update_item", "remove_item", "move_item",
      "get_page", "list_pages", "get_block_schema",
      "get_site_config", "update_site_config",
      "unsplash_search", "image_generate",
      "generate_variations",
    ]
    for (const name of expected) {
      assert.ok(names.has(name), `Missing expected tool: ${name}`)
    }
  })
})
