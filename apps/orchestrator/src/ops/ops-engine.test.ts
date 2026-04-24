import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { PageDoc, Operation } from "@ai-site-editor/shared"
import { draftPages, getSiteConfig, setSiteConfig } from "../state/session-state.js"
import {
  applyOpsAtomically,
  validateOperations,
  pickFocusBlockId,
  pickUpdatedSlug,
  classifyGuardrailError,
  isNoEffectiveChangeError,
  isDeterministicRepairEligible,
  toErrorDetail,
  parseSchemaViolationReason,
  buildDeterministicRepairFeedback
} from "./ops-engine.js"
import {
  makeHomePage as makePage,
  makePricingPage,
  makeFeaturePage,
  seedSession as seedSessionRaw,
  getDraft as getDraftRaw,
  resetSessionState,
  CTA_ONLY_MANIFEST
} from "../test/fixtures.js"

// ---------------------------------------------------------------------------
// Helpers — thin wrappers binding to a fixed session ID
// ---------------------------------------------------------------------------

const TEST_SESSION = "__test__"

function seedSession(...pages: PageDoc[]) {
  seedSessionRaw(TEST_SESSION, ...pages)
}

function getDraft(slug: string) {
  return getDraftRaw(TEST_SESSION, slug)
}

function resetState() {
  resetSessionState(TEST_SESSION)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ops-engine: add_block", () => {
  beforeEach(resetState)

  it("appends a block to the end when no afterBlockId", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_new",
        type: "CTA",
        props: { title: "New", description: "Desc", ctaText: "Go", ctaHref: "/" }
      }
    }
    await applyOpsAtomically(TEST_SESSION, [op])
    const page = getDraft("/")!
    assert.equal(page.blocks.length, 3)
    assert.equal(page.blocks[2].id, "b_new")
  })

  it("inserts after a specific block", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      afterBlockId: "b_hero",
      block: {
        id: "b_mid",
        type: "CTA",
        props: { title: "Mid", description: "D", ctaText: "X", ctaHref: "/" }
      }
    }
    await applyOpsAtomically(TEST_SESSION, [op])
    const page = getDraft("/")!
    assert.equal(page.blocks.length, 3)
    assert.equal(page.blocks[0].id, "b_hero")
    assert.equal(page.blocks[1].id, "b_mid")
    assert.equal(page.blocks[2].id, "b_cta")
  })

  it("rejects duplicate block id", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_hero",
        type: "CTA",
        props: { title: "Dup", description: "D", ctaText: "X", ctaHref: "/" }
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op]), /already exists/)
  })

  it("rejects invalid props", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_bad",
        type: "CTA",
        props: { title: "", description: "D", ctaText: "X", ctaHref: "/" }
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op]), /Invalid props/)
  })

  it("rejects when afterBlockId not found", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      afterBlockId: "b_nonexistent",
      block: {
        id: "b_new",
        type: "CTA",
        props: { title: "New", description: "D", ctaText: "X", ctaHref: "/" }
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op]), /afterBlockId/)
  })

  it("rejects when page not found", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/missing",
      block: {
        id: "b_new",
        type: "CTA",
        props: { title: "New", description: "D", ctaText: "X", ctaHref: "/" }
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op]), /Page not found/)
  })

  it("enforces manifest block type allow-list when provided", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_hero_new",
        type: "Hero",
        props: {
          heading: "Hello",
          subheading: "World",
          ctaText: "Go",
          ctaHref: "/",
          imageUrl: "/hero.svg",
          imageAlt: "Hero"
        }
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op], { componentsManifest: CTA_ONLY_MANIFEST }), /not declared in components manifest/)
  })

  it("validates props against manifest schema for known types", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_cta_missing_href",
        type: "CTA",
        props: { title: "T", description: "D", ctaText: "Go" } as Record<string, unknown>
      }
    }
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, [op], { componentsManifest: CTA_ONLY_MANIFEST }), /does not match block manifest schema/)
  })

  it("coerces numeric values to strings for Table rows", async () => {
    seedSession(makePage())
    const op: Operation = {
      op: "add_block",
      pageSlug: "/",
      block: {
        id: "b_table",
        type: "Table",
        props: {
          title: "Nutrition Facts",
          headers: ["Nutrient", "Amount"],
          rows: [["Calories", 884], ["Total Fat", 100]],
          striped: "true"
        } as Record<string, unknown>
      }
    }
    const result = await applyOpsAtomically(TEST_SESSION, [op])
    assert.equal(result.appliedCount, 1)
    const page = getDraft("/")!
    const table = page.blocks.find((b) => b.id === "b_table")!
    const rows = table.props.rows as string[][]
    assert.equal(rows[0][1], "884")
    assert.equal(rows[1][1], "100")
  })
})

describe("ops-engine: remove_block", () => {
  beforeEach(resetState)

  it("removes an existing block", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [{ op: "remove_block", pageSlug: "/", blockId: "b_cta" }])
    const page = getDraft("/")!
    assert.equal(page.blocks.length, 1)
    assert.equal(page.blocks[0].id, "b_hero")
  })

  it("rejects when blockId not found", async () => {
    seedSession(makePage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "remove_block", pageSlug: "/", blockId: "b_nope" }]),
      /not found/
    )
  })
})

describe("ops-engine: move_block", () => {
  beforeEach(resetState)

  it("moves a block to the top (no afterBlockId)", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [{ op: "move_block", pageSlug: "/", blockId: "b_cta" }])
    const page = getDraft("/")!
    assert.equal(page.blocks[0].id, "b_cta")
    assert.equal(page.blocks[1].id, "b_hero")
  })

  it("moves a block after another", async () => {
    // Add a third block first, then move it between the other two
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "add_block",
        pageSlug: "/",
        block: { id: "b_third", type: "CTA", props: { title: "T", description: "D", ctaText: "X", ctaHref: "/" } }
      }
    ])
    await applyOpsAtomically(TEST_SESSION, [
      { op: "move_block", pageSlug: "/", blockId: "b_third", afterBlockId: "b_hero" }
    ])
    const page = getDraft("/")!
    assert.equal(page.blocks[0].id, "b_hero")
    assert.equal(page.blocks[1].id, "b_third")
    assert.equal(page.blocks[2].id, "b_cta")
  })

  it("rejects when blockId not found", async () => {
    seedSession(makePage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "move_block", pageSlug: "/", blockId: "b_nope" }]),
      /not found/
    )
  })
})

describe("ops-engine: update_props", () => {
  beforeEach(resetState)

  it("updates a scalar prop", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "Updated Title" } }
    ])
    const block = getDraft("/")!.blocks.find((b) => b.id === "b_cta")!
    assert.equal((block.props as Record<string, unknown>).title, "Updated Title")
  })

  it("rejects unknown prop keys", async () => {
    seedSession(makePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { bogus: "value" } }
        ]),
      /unknown props/i
    )
  })

  it("rejects no-op patch (same value)", async () => {
    seedSession(makePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "Ready?" } }
        ]),
      /No effective prop change/
    )
  })

  it("rejects invalid value (empty string for required field)", async () => {
    seedSession(makePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { title: "" } }
        ]),
      /Invalid props/
    )
  })

  it("handles nested props object (unwraps .props wrapper)", async () => {
    seedSession(makePage())
    // The ops-engine unwraps { props: { ... } } to just { ... }
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_props", pageSlug: "/", blockId: "b_cta", patch: { props: { title: "Unwrapped" } } as any }
    ])
    const block = getDraft("/")!.blocks.find((b) => b.id === "b_cta")!
    assert.equal((block.props as Record<string, unknown>).title, "Unwrapped")
  })

  it("rejects updates to block types missing from provided manifest", async () => {
    seedSession(makePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(
          TEST_SESSION,
          [{ op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "Updated" } }],
          { componentsManifest: CTA_ONLY_MANIFEST }
        ),
      /not declared in components manifest/
    )
  })
})

describe("ops-engine: create_page", () => {
  beforeEach(resetState)

  it("creates a new page", async () => {
    seedSession(makePage())
    const newPage = makePricingPage()
    await applyOpsAtomically(TEST_SESSION, [{ op: "create_page", page: newPage }])
    const page = getDraft("/pricing")
    assert.ok(page)
    assert.equal(page!.title, "Pricing")
    assert.equal(page!.blocks.length, 1)
  })

  it("backfills id and updatedAt when caller omits them", async () => {
    // Agent create_page tool casts its input `as PageDoc` without setting id
    // or updatedAt. Without backfill, the stored page fails
    // pageDocSchemaLenient when the site fetches it → "Draft unavailable".
    seedSession(makePage())
    const partial = {
      slug: "/test",
      title: "Test",
      blocks: [{ id: "b_hero_test", type: "Hero", props: { heading: "Hi" } }],
    } as unknown as PageDoc
    await applyOpsAtomically(TEST_SESSION, [{ op: "create_page", page: partial }])
    const page = getDraft("/test")
    assert.ok(page)
    assert.equal(page!.id, "p_test")
    assert.ok(typeof page!.updatedAt === "string" && page!.updatedAt.length > 0)
  })
})

describe("ops-engine: remove_page", () => {
  beforeEach(resetState)

  it("removes a non-home page", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [{ op: "remove_page", pageSlug: "/pricing" }])
    assert.equal(getDraft("/pricing"), null)
    assert.ok(getDraft("/"))
  })

  it("rejects removing the home page", async () => {
    seedSession(makePage(), makePricingPage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "remove_page", pageSlug: "/" }]),
      /Cannot remove the home page/
    )
  })

  it("rejects removing the last page", async () => {
    seedSession(makePage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "remove_page", pageSlug: "/" }]),
      /Cannot remove/
    )
  })
})

describe("ops-engine: rename_page", () => {
  beforeEach(resetState)

  it("renames a page and rewrites links in other pages", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "rename_page", pageSlug: "/pricing", newPageSlug: "/plans" }
    ])
    assert.equal(getDraft("/pricing"), null)
    const plans = getDraft("/plans")
    assert.ok(plans)
    assert.equal(plans!.slug, "/plans")

    // The home page Hero had ctaHref: "/pricing" — should be rewritten to "/plans"
    const hero = getDraft("/")!.blocks.find((b) => b.id === "b_hero")!
    assert.equal((hero.props as Record<string, unknown>).ctaHref, "/plans")
  })

  it("rejects rename to existing slug", async () => {
    seedSession(makePage(), makePricingPage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "rename_page", pageSlug: "/pricing", newPageSlug: "/" }]),
      /already exists/
    )
  })

  it("rejects rename to same slug with no title change", async () => {
    seedSession(makePage(), makePricingPage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          { op: "rename_page", pageSlug: "/pricing", newPageSlug: "/pricing" }
        ]),
      /No effective page change.*matches current/
    )
  })

  it("rejects rename with no newPageSlug and no newTitle", async () => {
    seedSession(makePage(), makePricingPage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "rename_page", pageSlug: "/pricing" }]),
      /No effective page change.*newPageSlug not provided/
    )
  })

  it("rejects rename when newTitle matches current title", async () => {
    seedSession(makePage(), makePricingPage())
    const currentTitle = getDraft("/pricing")!.title
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          { op: "rename_page", pageSlug: "/pricing", newTitle: currentTitle }
        ]),
      /No effective page change.*matches current title/
    )
  })

  it("performs a title-only rename when newPageSlug is omitted", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "rename_page", pageSlug: "/pricing", newTitle: "Plans & Pricing" }
    ])
    const page = getDraft("/pricing")
    assert.ok(page, "page should still exist at /pricing after title-only rename")
    assert.equal(page!.title, "Plans & Pricing")
    assert.equal(page!.slug, "/pricing")

    // Internal links to /pricing should NOT be rewritten since slug didn't change.
    const hero = getDraft("/")!.blocks.find((b) => b.id === "b_hero")!
    assert.equal((hero.props as Record<string, unknown>).ctaHref, "/pricing")
  })

  it("performs a title-only rename when newPageSlug matches current slug", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "rename_page", pageSlug: "/pricing", newPageSlug: "/pricing", newTitle: "Our Plans" }
    ])
    const page = getDraft("/pricing")
    assert.ok(page)
    assert.equal(page!.title, "Our Plans")
  })

  it("preserves page position in nav order after rename", async () => {
    seedSession(makePage(), makePricingPage(), makeFeaturePage())
    const slugsBefore = Array.from(draftPages.get(TEST_SESSION)!.keys())
    assert.deepEqual(slugsBefore, ["/", "/pricing", "/features"])

    await applyOpsAtomically(TEST_SESSION, [
      { op: "rename_page", pageSlug: "/pricing", newPageSlug: "/plans" }
    ])

    const slugsAfter = Array.from(draftPages.get(TEST_SESSION)!.keys())
    assert.deepEqual(slugsAfter, ["/", "/plans", "/features"])
  })
})

describe("ops-engine: duplicate_page", () => {
  beforeEach(resetState)

  it("duplicates a page with auto-generated slug", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [{ op: "duplicate_page", pageSlug: "/pricing" }])
    const copy = getDraft("/pricing-copy")
    assert.ok(copy)
    assert.equal(copy!.blocks.length, 1)
    // Block IDs should be different from source
    assert.notEqual(copy!.blocks[0].id, "b_hero_pricing")
  })

  it("duplicates with explicit slug and title", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "duplicate_page", pageSlug: "/pricing", newPageSlug: "/enterprise", newTitle: "Enterprise" }
    ])
    const page = getDraft("/enterprise")
    assert.ok(page)
    assert.equal(page!.title, "Enterprise")
  })

  it("syncs meta.title with newTitle and returns a blockIdMap", async () => {
    const sourceWithMeta = {
      ...makePricingPage(),
      meta: { title: "Old SEO Title", description: "Old SEO description", ogImage: "/og.png" },
    }
    seedSession(makePage(), sourceWithMeta)
    const result = await applyOpsAtomically(TEST_SESSION, [
      { op: "duplicate_page", pageSlug: "/pricing", newPageSlug: "/enterprise", newTitle: "Enterprise" }
    ])
    const page = getDraft("/enterprise")!
    assert.equal(page.meta?.title, "Enterprise", "meta.title should sync with newTitle")
    assert.equal(page.meta?.description, "Old SEO description", "non-title meta fields should be preserved")
    assert.equal(page.meta?.ogImage, "/og.png", "ogImage should be preserved")
    assert.equal(result.duplicatedPages.length, 1)
    assert.equal(result.duplicatedPages[0].slug, "/enterprise")
    assert.equal(result.duplicatedPages[0].blockIdMap["b_hero_pricing"], page.blocks[0].id)
    assert.notEqual(page.blocks[0].id, "b_hero_pricing")
  })

  it("preserves source meta unchanged when newTitle is not passed", async () => {
    const sourceWithMeta = {
      ...makePricingPage(),
      meta: { title: "Pricing SEO", description: "Our plans" },
    }
    seedSession(makePage(), sourceWithMeta)
    await applyOpsAtomically(TEST_SESSION, [{ op: "duplicate_page", pageSlug: "/pricing" }])
    const page = getDraft("/pricing-copy")!
    assert.equal(page.meta?.title, "Pricing SEO")
    assert.equal(page.meta?.description, "Our plans")
  })
})

describe("ops-engine: move_page", () => {
  beforeEach(resetState)

  it("rejects moving the home page", async () => {
    seedSession(makePage(), makePricingPage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [{ op: "move_page", pageSlug: "/" }]),
      /Home page.*cannot be moved/
    )
  })
})

describe("ops-engine: duplicate_block", () => {
  beforeEach(resetState)

  it("duplicates a block within the same page", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "duplicate_block", pageSlug: "/", blockId: "b_cta" }
    ])
    const page = getDraft("/")!
    assert.equal(page.blocks.length, 3)
    // Original at idx 1, copy at idx 2
    assert.equal(page.blocks[1].id, "b_cta")
    assert.ok(page.blocks[2].id.startsWith("b_cta"))
    assert.notEqual(page.blocks[2].id, "b_cta")
  })

  it("duplicates a block to another page", async () => {
    seedSession(makePage(), makePricingPage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "duplicate_block", pageSlug: "/", blockId: "b_cta", toPageSlug: "/pricing" }
    ])
    const pricing = getDraft("/pricing")!
    assert.equal(pricing.blocks.length, 2)
  })
})

describe("ops-engine: list item operations", () => {
  beforeEach(resetState)

  it("add_item appends to list", async () => {
    seedSession(makeFeaturePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "add_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        item: { title: "New", description: "New feature." }
      }
    ])
    const block = getDraft("/features")!.blocks[0]
    const features = (block.props as Record<string, unknown>).features as unknown[]
    assert.equal(features.length, 4)
    assert.deepEqual(features[3], { title: "New", description: "New feature." })
  })

  it("add_item inserts at specific position", async () => {
    seedSession(makeFeaturePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "add_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        afterIndex: 0,
        item: { title: "Inserted", description: "After first." }
      }
    ])
    const features = (getDraft("/features")!.blocks[0].props as Record<string, unknown>).features as Array<{
      title: string
    }>
    assert.equal(features.length, 4)
    assert.equal(features[1].title, "Inserted")
  })

  it("update_item patches a list item", async () => {
    seedSession(makeFeaturePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "update_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        index: 1,
        patch: { title: "Updated Safe" }
      }
    ])
    const features = (getDraft("/features")!.blocks[0].props as Record<string, unknown>).features as Array<{
      title: string
    }>
    assert.equal(features[1].title, "Updated Safe")
    // Other items unchanged
    assert.equal(features[0].title, "Fast")
  })

  it("remove_item removes from list", async () => {
    seedSession(makeFeaturePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "remove_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        index: 1
      }
    ])
    const features = (getDraft("/features")!.blocks[0].props as Record<string, unknown>).features as Array<{
      title: string
    }>
    assert.equal(features.length, 2)
    assert.equal(features[0].title, "Fast")
    assert.equal(features[1].title, "Simple")
  })

  it("move_item reorders within list", async () => {
    seedSession(makeFeaturePage())
    // Move last item (index 2) to the front (no afterIndex = position 0)
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "move_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        index: 2
      }
    ])
    const features = (getDraft("/features")!.blocks[0].props as Record<string, unknown>).features as Array<{
      title: string
    }>
    assert.equal(features[0].title, "Simple")
    assert.equal(features[1].title, "Fast")
    assert.equal(features[2].title, "Safe")
  })

  it("move_item accepts pre-move afterIndex when moving down", async () => {
    seedSession(makeFeaturePage())
    await applyOpsAtomically(TEST_SESSION, [
      {
        op: "move_item",
        pageSlug: "/features",
        blockId: "b_grid",
        listKey: "features",
        index: 0,
        afterIndex: 1
      }
    ])
    const features = (getDraft("/features")!.blocks[0].props as Record<string, unknown>).features as Array<{
      title: string
    }>
    assert.equal(features[0].title, "Safe")
    assert.equal(features[1].title, "Fast")
    assert.equal(features[2].title, "Simple")
  })

  it("rejects out-of-range index for update_item", async () => {
    seedSession(makeFeaturePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          {
            op: "update_item",
            pageSlug: "/features",
            blockId: "b_grid",
            listKey: "features",
            index: 99,
            patch: { title: "Nope" }
          }
        ]),
      /out of range/
    )
  })

  it("rejects invalid listKey", async () => {
    seedSession(makeFeaturePage())
    await assert.rejects(
      () =>
        applyOpsAtomically(TEST_SESSION, [
          {
            op: "add_item",
            pageSlug: "/features",
            blockId: "b_grid",
            listKey: "nonexistent",
            item: { title: "X", description: "Y" }
          }
        ]),
      /not found/
    )
  })
})

describe("ops-engine: atomicity", () => {
  beforeEach(resetState)

  it("rolls back all changes when a later operation fails", async () => {
    seedSession(makePage())
    const originalBlocks = getDraft("/")!.blocks.map((b) => b.id)

    await assert.rejects(() =>
      applyOpsAtomically(TEST_SESSION, [
        // First op is valid
        {
          op: "add_block",
          pageSlug: "/",
          block: { id: "b_temp", type: "CTA", props: { title: "T", description: "D", ctaText: "X", ctaHref: "/" } }
        },
        // Second op fails (unknown block)
        { op: "remove_block", pageSlug: "/", blockId: "b_nonexistent" }
      ])
    )

    // State should be unchanged — the first add_block should NOT have persisted
    const page = getDraft("/")!
    const currentIds = page.blocks.map((b) => b.id)
    assert.deepEqual(currentIds, originalBlocks)
  })

  it("throws when ops produce no changes", async () => {
    seedSession(makePage())
    // An empty ops list produces no changes
    await assert.rejects(() => applyOpsAtomically(TEST_SESSION, []), /no changes/)
  })

  it("rolls back site config changes when a later op fails", async () => {
    seedSession(makePage())
    setSiteConfig(TEST_SESSION, { name: "Original Name", logo: "/logos/original.svg", navLabels: { "/": "Home" } })

    await assert.rejects(() =>
      applyOpsAtomically(TEST_SESSION, [
        { op: "update_site_config", patch: { name: "Should Not Persist", navLabels: { "/pricing": "Plans" } } },
        { op: "remove_block", pageSlug: "/", blockId: "b_nonexistent" }
      ])
    )

    const config = getSiteConfig(TEST_SESSION)
    assert.equal(config.name, "Original Name")
    assert.equal(config.logo, "/logos/original.svg")
    assert.deepEqual(config.navLabels, { "/": "Home" })
  })
})

describe("ops-engine: multi-op sequences", () => {
  beforeEach(resetState)

  it("creates a page and adds a block in one atomic batch", async () => {
    seedSession(makePage())
    const newPage: PageDoc = {
      id: "p_about",
      slug: "/about",
      title: "About",
      updatedAt: new Date().toISOString(),
      blocks: []
    }
    await applyOpsAtomically(TEST_SESSION, [
      { op: "create_page", page: newPage },
      {
        op: "add_block",
        pageSlug: "/about",
        block: { id: "b_about_hero", type: "CTA", props: { title: "About", description: "Us", ctaText: "Learn", ctaHref: "/" } }
      }
    ])
    const about = getDraft("/about")!
    assert.equal(about.blocks.length, 1)
    assert.equal(about.blocks[0].id, "b_about_hero")
  })
})

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("pickFocusBlockId", () => {
  it("picks add_block id first", () => {
    const ops: Operation[] = [
      { op: "update_props", pageSlug: "/", blockId: "b_1", patch: { title: "X" } },
      { op: "add_block", pageSlug: "/", block: { id: "b_new", type: "CTA", props: {} } }
    ]
    assert.equal(pickFocusBlockId(ops), "b_new")
  })

  it("picks update_props blockId when no add", () => {
    const ops: Operation[] = [
      { op: "update_props", pageSlug: "/", blockId: "b_1", patch: { title: "X" } }
    ]
    assert.equal(pickFocusBlockId(ops), "b_1")
  })

  it("returns undefined for page-level ops only", () => {
    const ops: Operation[] = [{ op: "remove_page", pageSlug: "/pricing" }]
    assert.equal(pickFocusBlockId(ops), undefined)
  })
})

describe("pickUpdatedSlug", () => {
  beforeEach(resetState)

  it("returns created page slug", () => {
    seedSession(makePage())
    const ops: Operation[] = [
      {
        op: "create_page",
        page: { id: "p", slug: "/new", title: "New", updatedAt: "", blocks: [] }
      }
    ]
    assert.equal(pickUpdatedSlug(TEST_SESSION, "/", ops), "/new")
  })

  it("returns undefined when multiple pages are created", () => {
    seedSession(makePage())
    const ops: Operation[] = [
      {
        op: "create_page",
        page: { id: "p1", slug: "/about", title: "About", updatedAt: "", blocks: [] }
      },
      {
        op: "create_page",
        page: { id: "p2", slug: "/pricing", title: "Pricing", updatedAt: "", blocks: [] }
      }
    ]
    assert.equal(pickUpdatedSlug(TEST_SESSION, "/", ops), undefined)
  })

  it("returns undefined when current page still exists", () => {
    seedSession(makePage())
    const ops: Operation[] = [
      { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "X" } }
    ]
    assert.equal(pickUpdatedSlug(TEST_SESSION, "/", ops), undefined)
  })
})

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("classifyGuardrailError", () => {
  it("classifies schema violations", () => {
    assert.equal(classifyGuardrailError("Invalid props for Hero"), "schema_violation")
    assert.equal(classifyGuardrailError("heading is required"), "schema_violation")
  })

  it("classifies not_found", () => {
    assert.equal(classifyGuardrailError("Page not found for slug /x"), "not_found")
    assert.equal(classifyGuardrailError("blockId b_1 not found"), "not_found")
  })

  it("classifies ambiguity", () => {
    assert.equal(classifyGuardrailError("Request is ambiguous"), "ambiguity")
  })

  it("classifies no effective change", () => {
    assert.equal(classifyGuardrailError("No effective prop change for b_1"), "no_effective_change")
  })

  it("classifies planner refusal/incomplete/malformed output", () => {
    assert.equal(classifyGuardrailError("Model refused planning output: blocked"), "planner_refusal")
    assert.equal(classifyGuardrailError("Model returned incomplete planning output"), "incomplete_output")
    assert.equal(classifyGuardrailError("Model did not return JSON"), "malformed_output")
  })

  it("classifies JSON parse errors as malformed_output", () => {
    assert.equal(classifyGuardrailError("Expected ',' or '}' after property value in JSON at position 412"), "malformed_output")
    assert.equal(classifyGuardrailError("No number after minus sign in JSON at position 89"), "malformed_output")
    assert.equal(classifyGuardrailError("Unexpected token \n in JSON at position 200"), "malformed_output")
    assert.equal(classifyGuardrailError("SyntaxError: in JSON at position 50"), "malformed_output")
  })

  it("falls back to internal_error", () => {
    assert.equal(classifyGuardrailError("something weird happened"), "internal_error")
  })
})

describe("isNoEffectiveChangeError", () => {
  it("matches the pattern", () => {
    assert.equal(isNoEffectiveChangeError("No effective prop change for b_cta"), true)
    assert.equal(isNoEffectiveChangeError("some other error"), false)
  })
})

describe("isDeterministicRepairEligible", () => {
  it("is eligible for schema violations", () => {
    assert.equal(isDeterministicRepairEligible("Invalid props for CTA: title required"), true)
  })

  it("is not eligible for not_found", () => {
    assert.equal(isDeterministicRepairEligible("Page not found"), false)
  })
})

describe("parseSchemaViolationReason", () => {
  it("extracts path + classifies unknown_key violation", () => {
    const r = parseSchemaViolationReason(
      "Unrecognized key(s) in object: 'color' at ops.0.patch. Parsed sample: {\"intent\":\"edit_plan\"}"
    )
    assert.equal(r.path, "ops.0.patch")
    assert.equal(r.kind, "unknown_key")
    assert.match(r.zodMessage, /Unrecognized key/)
  })

  it("classifies missing_required", () => {
    const r = parseSchemaViolationReason("Required at ops.1.blockId. Parsed sample: {}")
    assert.equal(r.path, "ops.1.blockId")
    assert.equal(r.kind, "missing_required")
  })

  it("classifies invalid_discriminator", () => {
    const r = parseSchemaViolationReason("Invalid discriminator value at ops.0.op. Parsed sample: {}")
    assert.equal(r.kind, "invalid_discriminator")
  })

  it("classifies type_mismatch", () => {
    const r = parseSchemaViolationReason("Expected string, received number at ops.0.patch.heading. Parsed sample: {}")
    assert.equal(r.kind, "type_mismatch")
    assert.equal(r.path, "ops.0.patch.heading")
  })

  it("classifies invalid_enum", () => {
    const r = parseSchemaViolationReason("Invalid enum value at ops.0.op. Parsed sample: {}")
    assert.equal(r.kind, "invalid_enum")
  })

  it("classifies string_constraint", () => {
    const r = parseSchemaViolationReason("String must contain at least 1 character(s) at ops.0.patch.heading. Parsed sample: {}")
    assert.equal(r.kind, "string_constraint")
  })

  it("returns nulls for reasons without a path", () => {
    const r = parseSchemaViolationReason("Invalid props for Hero")
    assert.equal(r.path, null)
    assert.equal(r.kind, "unknown")
  })
})

describe("buildDeterministicRepairFeedback", () => {
  it("cites violation path + gives unknown_key guidance", () => {
    const fb = buildDeterministicRepairFeedback(
      "Unrecognized key(s) in object: 'color' at ops.0.patch. Parsed sample: {}"
    )
    assert.match(fb, /Violation path: ops\.0\.patch/)
    assert.match(fb, /remove the unknown key/i)
    assert.match(fb, /Do not change user intent/)
  })

  it("gives missing_required guidance", () => {
    const fb = buildDeterministicRepairFeedback("Required at ops.1.blockId. Parsed sample: {}")
    assert.match(fb, /missing required field/i)
  })

  it("gives discriminator guidance listing operation names", () => {
    const fb = buildDeterministicRepairFeedback("Invalid discriminator value at ops.0.op. Parsed sample: {}")
    assert.match(fb, /update_props/)
  })

  it("falls back to generic guidance when reason is unparseable", () => {
    const fb = buildDeterministicRepairFeedback("something weird")
    assert.match(fb, /re-read the block's contract/)
  })

  it("tells the LLM to keep every op the original plan had", () => {
    const fb = buildDeterministicRepairFeedback("Required at ops.1.blockId. Parsed sample: {}")
    assert.match(fb, /Keep every op the original plan had/)
  })
})

describe("toErrorDetail", () => {
  it("extracts message from Error", () => {
    assert.equal(toErrorDetail(new Error("broken")), "broken")
  })

  it("extracts first issue from zod-like error", () => {
    const zodLike = { issues: [{ message: "Invalid value", path: ["heading"] }] }
    assert.equal(toErrorDetail(zodLike), "Invalid value at heading")
  })

  it("returns string as-is", () => {
    assert.equal(toErrorDetail("plain string"), "plain string")
  })

  it("falls back for unknown types", () => {
    assert.equal(toErrorDetail(42), "Unknown planner error")
  })
})

// ---------------------------------------------------------------------------
// update_page_meta
// ---------------------------------------------------------------------------

describe("ops-engine: update_page_meta", () => {
  beforeEach(resetState)

  it("sets meta on page with no existing meta", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_page_meta", pageSlug: "/", patch: { title: "SEO Title", description: "A great page" } }
    ])
    const page = getDraft("/")!
    assert.deepEqual(page.meta, { title: "SEO Title", description: "A great page" })
  })

  it("merge-patches existing meta", async () => {
    const page = makePage()
    page.meta = { title: "Old Title", description: "Old desc" }
    seedSession(page)
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_page_meta", pageSlug: "/", patch: { description: "New desc" } }
    ])
    const updated = getDraft("/")!
    assert.equal(updated.meta!.title, "Old Title")
    assert.equal(updated.meta!.description, "New desc")
  })

  it("sets ogImage", async () => {
    seedSession(makePage())
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_page_meta", pageSlug: "/", patch: { ogImage: "https://example.com/og.png" } }
    ])
    const page = getDraft("/")!
    assert.equal(page.meta!.ogImage, "https://example.com/og.png")
  })

  it("rejects when page not found", async () => {
    seedSession(makePage())
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [
        { op: "update_page_meta", pageSlug: "/missing", patch: { title: "Nope" } }
      ]),
      /Page not found/
    )
  })

  it("rejects no-op update", async () => {
    const page = makePage()
    page.meta = { title: "Same" }
    seedSession(page)
    await assert.rejects(
      () => applyOpsAtomically(TEST_SESSION, [
        { op: "update_page_meta", pageSlug: "/", patch: { title: "Same" } }
      ]),
      /No effective meta change/
    )
  })

  it("clears a field with empty string", async () => {
    const page = makePage()
    page.meta = { title: "To Remove", description: "Keep this" }
    seedSession(page)
    await applyOpsAtomically(TEST_SESSION, [
      { op: "update_page_meta", pageSlug: "/", patch: { title: "" } }
    ])
    const updated = getDraft("/")!
    assert.equal(updated.meta!.title, undefined)
    assert.equal(updated.meta!.description, "Keep this")
  })
})

// ---------------------------------------------------------------------------
// validateOperations — typed contract layer
// ---------------------------------------------------------------------------

describe("validateOperations", () => {
  it("accepts valid operations and returns typed array", () => {
    const ops: Operation[] = [
      { op: "update_props", pageSlug: "/", blockId: "b_hero", patch: { heading: "Hello" } },
      { op: "remove_block", pageSlug: "/", blockId: "b_cta" }
    ]
    const result = validateOperations(ops)
    assert.equal(result.length, 2)
    assert.equal(result[0].op, "update_props")
    assert.equal(result[1].op, "remove_block")
  })

  it("rejects operation with unknown op name", () => {
    assert.throws(
      () => validateOperations([{ op: "invalid_op", pageSlug: "/" }]),
      /contract violation/
    )
  })

  it("rejects operation missing required fields", () => {
    assert.throws(
      () => validateOperations([{ op: "update_props" }]),
      /contract violation/
    )
  })

  it("rejects non-array elements in ops", () => {
    assert.throws(
      () => validateOperations(["not_an_op"]),
      /contract violation/
    )
  })

  it("returns empty array for empty input", () => {
    const result = validateOperations([])
    assert.equal(result.length, 0)
  })
})
